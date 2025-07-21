from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import os
import eventlet
eventlet.monkey_patch()
import uuid
from werkzeug.utils import secure_filename
import time
import redis
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'your-secret-key-change-in-production')
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max file size

# Ensure upload directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

def create_redis_connection():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:6379')
    
    if redis_url == 'none':
        return None
    
    try:
        if redis_url.startswith('redis://'):
            redis_host = redis_url.split('@')[-1].split(':')[0]
            redis_port = int(redis_url.split(':')[-1])
        else:
            redis_host = 'red-d1uhscemcj7s73ehu9d0'
            redis_port = 6379
        
        redis_client = redis.Redis(
            host=redis_host,
            port=redis_port,
            decode_responses=True,
            socket_timeout=3,
            socket_connect_timeout=3,
            socket_keepalive=True,
            socket_keepalive_options={},
            retry_on_timeout=True,
            health_check_interval=10,
            max_connections=30
        )
        
        redis_client.ping()
        logger.info(f"✅ Redis connection successful: {redis_host}:{redis_port}")
        return redis_client
        
    except Exception as e:
        logger.error(f"❌ Redis connection failed: {e}")
        return None

redis_client = create_redis_connection()

def create_socketio():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:6379')
    
    if redis_url == 'none' or not redis_client:
        logger.warning("🔄 Running without Redis (single instance mode)")
        return SocketIO(
            app, 
            cors_allowed_origins="*",
            logger=False,
            engineio_logger=False,
            ping_timeout=10,
            ping_interval=5
        )
    
    try:
        socketio_instance = SocketIO(
            app, 
            cors_allowed_origins="*",
            message_queue=redis_url,
            logger=False,
            engineio_logger=False,
            ping_timeout=20,
            ping_interval=10
        )
        logger.info(f"✅ SocketIO connected with Redis: {redis_url}")
        return socketio_instance
        
    except Exception as e:
        logger.error(f"⚠️ Redis connection failed, falling back to single instance: {e}")
        return SocketIO(
            app, 
            cors_allowed_origins="*",
            logger=False,
            engineio_logger=False,
            ping_timeout=20,
            ping_interval=10
        )

socketio = create_socketio()
rooms = {}

# High precision timestamp function
def get_precise_timestamp():
    """Get high precision timestamp in milliseconds"""
    return int(time.time() * 1000)

@app.route('/health')
def health_check():
    redis_status = "disconnected"
    if redis_client:
        try:
            redis_client.ping()
            redis_status = "connected"
        except:
            redis_status = "error"
    
    return jsonify({
        'status': 'healthy',
        'redis': redis_status,
        'rooms': len(rooms),
        'server_time': get_precise_timestamp()
    }), 200

def store_room_state(room_id, room_data):
    """Store room state in Redis for persistence"""
    if redis_client:
        try:
            redis_client.setex(
                f"room:{room_id}", 
                3600,
                str(room_data)
            )
        except Exception as e:
            logger.warning(f"Failed to store room state in Redis: {e}")

def get_room_state(room_id):
    """Get room state from Redis"""
    if redis_client:
        try:
            return redis_client.get(f"room:{room_id}")
        except Exception as e:
            logger.warning(f"Failed to get room state from Redis: {e}")
    return None

def emit_with_retry(event, data, room=None, retries=3):
    """Emit with retry logic for critical events"""
    for attempt in range(retries):
        try:
            if room:
                emit(event, data, room=room)
            else:
                emit(event, data)
            break
        except Exception as e:
            logger.warning(f"Emit failed (attempt {attempt + 1}): {e}")
            if attempt == retries - 1:
                logger.error(f"Failed to emit {event} after {retries} attempts")

ALLOWED_EXTENSIONS = {'mp3', 'wav', 'ogg', 'm4a', 'flac'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file selected'})
    
    file = request.files['file']
    room_id = request.form.get('room_id')
    
    if file.filename == '':
        return jsonify({'error': 'No file selected'})
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        filename = f"{int(time.time())}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(file_path)
        
        if room_id in rooms:
            timestamp = get_precise_timestamp()
            rooms[room_id]['current_song'] = filename
            rooms[room_id]['position'] = 0
            rooms[room_id]['is_playing'] = False
            rooms[room_id]['last_update'] = timestamp
            
            store_room_state(room_id, rooms[room_id])
            
            try:
                socketio.emit('song_changed', {
                    'song': filename,
                    'position': 0,
                    'is_playing': False,
                    'timestamp': timestamp
                }, room=room_id)
                logger.info(f"Song changed notification sent to room {room_id}")
            except Exception as e:
                logger.error(f"Failed to notify room {room_id} of song change: {e}")
        
        return jsonify({'success': True, 'filename': filename})
    
    return jsonify({'error': 'Invalid file type'})

@app.route('/end_session', methods=['POST'])
def end_session():
    """Endpoint to clean up session when host leaves"""
    data = request.get_json()
    room_id = data.get('room_id')
    
    if not room_id or room_id not in rooms:
        return jsonify({'error': 'Room not found'})
    
    room_data = rooms[room_id]
    current_song = room_data.get('current_song')
    if current_song:
        song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
        if os.path.exists(song_path):
            try:
                os.remove(song_path)
                logger.info(f"✅ Deleted song after session: {song_path}")
                
                if redis_client:
                    try:
                        redis_client.delete(f"room:{room_id}")
                    except Exception as e:
                        logger.warning(f"Failed to clean Redis room data: {e}")
                        
                return jsonify({'success': True, 'message': 'Session cleaned up successfully'})
            except Exception as e:
                logger.error(f"⚠️ Error deleting song {song_path}: {e}")
                return jsonify({'error': f'Error deleting file: {str(e)}'})
    
    return jsonify({'success': True, 'message': 'No files to clean up'})

# Enhanced sync endpoint for time synchronization
@app.route('/sync_time', methods=['GET'])
def sync_time():
    """Endpoint for clients to sync their time with server"""
    return jsonify({
        'server_time': get_precise_timestamp()
    })

@socketio.on('ping_sync')
def handle_ping_sync():
    """Handle ping for latency measurement"""
    emit('pong_sync', {'server_time': get_precise_timestamp()})

@socketio.on('create_room')
def handle_create_room(data):
    room_id = str(uuid.uuid4())[:8]
    password = data.get('password', '')
    timestamp = get_precise_timestamp()
    
    rooms[room_id] = {
        'host': request.sid,
        'password': password,
        'clients': [],
        'current_song': None,
        'position': 0,
        'is_playing': False,
        'last_update': timestamp,
        'play_start_time': None,
        'sync_interval': 1000  # Sync every 1 second
    }
    
    join_room(room_id)
    rooms[room_id]['clients'].append({
        'id': request.sid,
        'is_host': True,
        'latency': 0
    })
    
    store_room_state(room_id, rooms[room_id])
    
    emit('room_created', {
        'room_id': room_id,
        'is_host': True,
        'server_time': timestamp
    })
    
    logger.info(f"Room created: {room_id}")

@socketio.on('join_room')
def handle_join_room(data):
    room_id = data.get('room_id')
    password = data.get('password', '')
    
    if room_id not in rooms:
        emit('join_error', {'message': 'Room not found'})
        return
    
    if rooms[room_id]['password'] != password:
        emit('join_error', {'message': 'Incorrect password'})
        return
    
    join_room(room_id)
    timestamp = get_precise_timestamp()
    
    rooms[room_id]['clients'].append({
        'id': request.sid,
        'is_host': False,
        'latency': 0
    })
    
    store_room_state(room_id, rooms[room_id])
    
    # Calculate current position if playing
    current_position = rooms[room_id]['position']
    if rooms[room_id]['is_playing'] and rooms[room_id]['play_start_time']:
        elapsed = (timestamp - rooms[room_id]['play_start_time']) / 1000.0
        current_position += elapsed
    
    emit('room_joined', {
        'room_id': room_id,
        'is_host': False,
        'current_song': rooms[room_id]['current_song'],
        'position': current_position,
        'is_playing': rooms[room_id]['is_playing'],
        'server_time': timestamp,
        'last_update': rooms[room_id]['last_update']
    })
    
    emit_with_retry('clients_updated', {
        'clients': len(rooms[room_id]['clients'])
    }, room=room_id)
    
    logger.info(f"Client joined room {room_id}")

@socketio.on('update_latency')
def handle_update_latency(data):
    """Update client latency for better sync"""
    room_id = data.get('room_id')
    latency = data.get('latency', 0)
    
    if room_id in rooms:
        for client in rooms[room_id]['clients']:
            if client['id'] == request.sid:
                client['latency'] = latency
                break

@socketio.on('play_pause')
def handle_play_pause(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    timestamp = get_precise_timestamp()
    is_playing = data.get('is_playing')
    position = data.get('position', 0)
    
    rooms[room_id]['is_playing'] = is_playing
    rooms[room_id]['position'] = position
    rooms[room_id]['last_update'] = timestamp
    
    if is_playing:
        rooms[room_id]['play_start_time'] = timestamp
    else:
        rooms[room_id]['play_start_time'] = None
    
    store_room_state(room_id, rooms[room_id])
    
    # Emit with precise timing
    sync_data = {
        'is_playing': is_playing,
        'position': position,
        'timestamp': timestamp,
        'play_start_time': rooms[room_id]['play_start_time']
    }
    
    emit_with_retry('sync_playback', sync_data, room=room_id)
    logger.info(f"Play/Pause sync sent for room {room_id}: playing={is_playing}, pos={position}")

@socketio.on('seek')
def handle_seek(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    timestamp = get_precise_timestamp()
    position = data.get('position', 0)
    
    rooms[room_id]['position'] = position
    rooms[room_id]['last_update'] = timestamp
    
    # Reset play start time if currently playing
    if rooms[room_id]['is_playing']:
        rooms[room_id]['play_start_time'] = timestamp
    
    store_room_state(room_id, rooms[room_id])
    
    sync_data = {
        'position': position,
        'timestamp': timestamp,
        'is_playing': rooms[room_id]['is_playing'],
        'play_start_time': rooms[room_id]['play_start_time']
    }
    
    emit_with_retry('sync_seek', sync_data, room=room_id)
    logger.info(f"Seek sync sent for room {room_id}: pos={position}")

@socketio.on('request_sync')
def handle_request_sync(data):
    """Handle explicit sync requests from clients"""
    room_id = data.get('room_id')
    
    if room_id not in rooms:
        return
    
    room_data = rooms[room_id]
    timestamp = get_precise_timestamp()
    
    # Calculate current position
    current_position = room_data['position']
    if room_data['is_playing'] and room_data['play_start_time']:
        elapsed = (timestamp - room_data['play_start_time']) / 1000.0
        current_position += elapsed
    
    emit('force_sync', {
        'position': current_position,
        'is_playing': room_data['is_playing'],
        'timestamp': timestamp,
        'play_start_time': room_data['play_start_time']
    })

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    
    for room_id in list(rooms.keys()):
        room_data = rooms[room_id]
        rooms[room_id]['clients'] = [c for c in room_data['clients'] if c['id'] != request.sid]

        if room_data['host'] == request.sid:
            if room_data['clients']:
                new_host = room_data['clients'][0]
                rooms[room_id]['host'] = new_host['id']
                new_host['is_host'] = True
                
                store_room_state(room_id, rooms[room_id])
                
                emit('new_host', {'is_host': True}, room=new_host['id'])
                logger.info(f"New host assigned in room {room_id}: {new_host['id']}")

        if not room_data['clients']:
            current_song = room_data.get('current_song')
            if current_song:
                song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
                if os.path.exists(song_path):
                    try:
                        os.remove(song_path)
                        logger.info(f"✅ Deleted song after session: {song_path}")
                    except Exception as e:
                        logger.error(f"⚠️ Error deleting song {song_path}: {e}")
            
            if redis_client:
                try:
                    redis_client.delete(f"room:{room_id}")
                except Exception as e:
                    logger.warning(f"Failed to clean Redis room data: {e}")
            
            del rooms[room_id]
            logger.info(f"Room cleaned up: {room_id}")

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 10000)))