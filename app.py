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

# Enhanced Redis configuration for music streaming
def create_redis_connection():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:6379')
    
    if redis_url == 'none':
        return None
    
    try:
        # Parse Redis URL to get connection params
        if redis_url.startswith('redis://'):
            redis_host = redis_url.split('@')[-1].split(':')[0]
            redis_port = int(redis_url.split(':')[-1])
        else:
            redis_host = 'red-d1uhscemcj7s73ehu9d0'
            redis_port = 6379
        
        # Create Redis client with robust settings
        redis_client = redis.Redis(
            host=redis_host,
            port=redis_port,
            decode_responses=True,
            socket_timeout=3,  # Quick timeout for music apps
            socket_connect_timeout=3,
            socket_keepalive=True,
            socket_keepalive_options={},
            retry_on_timeout=True,
            retry_on_error=[
                redis.exceptions.ConnectionError,
                redis.exceptions.TimeoutError,
                redis.exceptions.BusyLoadingError
            ],
            health_check_interval=10,  # Health check every 10 seconds
            max_connections=30,  # Higher pool for multiple rooms
            retry=redis.Retry(
                redis.backoff.ExponentialBackoff(),
                retries=3
            )
        )
        
        # Test connection
        redis_client.ping()
        logger.info(f"✅ Redis connection successful: {redis_host}:{redis_port}")
        return redis_client
        
    except Exception as e:
        logger.error(f"❌ Redis connection failed: {e}")
        return None

# Initialize Redis connection
redis_client = create_redis_connection()

# Enhanced SocketIO setup with better error handling
def create_socketio():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:6379')
    
    if redis_url == 'none' or not redis_client:
        logger.warning("🔄 Running without Redis (single instance mode)")
        return SocketIO(
            app, 
            cors_allowed_origins="*",
            logger=False,  # Reduce log spam
            engineio_logger=False,
            ping_timeout=20,
            ping_interval=10
        )
    
    try:
        socketio_instance = SocketIO(
            app, 
            cors_allowed_origins="*",
            message_queue=redis_url,
            logger=False,
            engineio_logger=False,
            ping_timeout=20,
            ping_interval=10,
            # Additional Redis-specific settings
            redis_options={
                'socket_timeout': 3,
                'socket_connect_timeout': 3,
                'retry_on_timeout': True,
                'health_check_interval': 10
            }
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

# Store room data with Redis backup
rooms = {}

# Health check endpoint
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
        'rooms': len(rooms)
    }), 200

# Redis helper functions
def store_room_state(room_id, room_data):
    """Store room state in Redis for persistence"""
    if redis_client:
        try:
            redis_client.setex(
                f"room:{room_id}", 
                3600,  # 1 hour expiry
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

# Enhanced error handling for critical events
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
        # Add timestamp to avoid conflicts
        filename = f"{int(time.time())}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(file_path)
        
        # Update room with new song
        if room_id in rooms:
            rooms[room_id]['current_song'] = filename
            rooms[room_id]['position'] = 0
            rooms[room_id]['is_playing'] = False
            
            # Store in Redis
            store_room_state(room_id, rooms[room_id])
            
            # Notify all clients in room with retry
            try:
                socketio.emit('song_changed', {
                    'song': filename,
                    'position': 0,
                    'is_playing': False
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
    
    # Delete the uploaded song if any
    current_song = room_data.get('current_song')
    if current_song:
        song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
        if os.path.exists(song_path):
            try:
                os.remove(song_path)
                logger.info(f"✅ Deleted song after session: {song_path}")
                
                # Clean up Redis
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

# Rest of your SocketIO events with enhanced error handling...
@socketio.on('create_room')
def handle_create_room(data):
    room_id = str(uuid.uuid4())[:8]
    password = data.get('password', '')
    
    rooms[room_id] = {
        'host': request.sid,
        'password': password,
        'clients': [],
        'current_song': None,
        'position': 0,
        'is_playing': False,
        'last_update': time.time()
    }
    
    join_room(room_id)
    rooms[room_id]['clients'].append({
        'id': request.sid,
        'is_host': True
    })
    
    # Store in Redis
    store_room_state(room_id, rooms[room_id])
    
    emit('room_created', {
        'room_id': room_id,
        'is_host': True
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
    rooms[room_id]['clients'].append({
        'id': request.sid,
        'is_host': False
    })
    
    # Store updated state
    store_room_state(room_id, rooms[room_id])
    
    # Send current state to new client
    emit('room_joined', {
        'room_id': room_id,
        'is_host': False,
        'current_song': rooms[room_id]['current_song'],
        'position': rooms[room_id]['position'],
        'is_playing': rooms[room_id]['is_playing']
    })
    
    # Update client list for all users with retry
    emit_with_retry('clients_updated', {
        'clients': len(rooms[room_id]['clients'])
    }, room=room_id)
    
    logger.info(f"Client joined room {room_id}")

@socketio.on('play_pause')
def handle_play_pause(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    rooms[room_id]['is_playing'] = data.get('is_playing')
    rooms[room_id]['position'] = data.get('position', 0)
    rooms[room_id]['last_update'] = time.time()
    
    # Store updated state
    store_room_state(room_id, rooms[room_id])
    
    # Critical sync event - use retry
    emit_with_retry('sync_playback', {
        'is_playing': rooms[room_id]['is_playing'],
        'position': rooms[room_id]['position'],
        'timestamp': rooms[room_id]['last_update']
    }, room=room_id)

@socketio.on('seek')
def handle_seek(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    rooms[room_id]['position'] = data.get('position', 0)
    rooms[room_id]['last_update'] = time.time()
    
    # Store updated state
    store_room_state(room_id, rooms[room_id])
    
    # Critical sync event - use retry
    emit_with_retry('sync_seek', {
        'position': rooms[room_id]['position'],
        'timestamp': rooms[room_id]['last_update']
    }, room=room_id)

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    
    # We make a list of room IDs to avoid modifying dict while iterating
    for room_id in list(rooms.keys()):
        room_data = rooms[room_id]
        # Remove this client from the room's client list
        room_data['clients'] = [c for c in room_data['clients'] if c['id'] != request.sid]

        # If the host left, assign a new host
        if room_data['host'] == request.sid:
            if room_data['clients']:
                # Promote first remaining client to host
                new_host = room_data['clients'][0]
                rooms[room_id]['host'] = new_host['id']
                new_host['is_host'] = True
                
                # Store updated state
                store_room_state(room_id, rooms[room_id])
                
                emit('new_host', {'is_host': True}, room=new_host['id'])
                logger.info(f"New host assigned in room {room_id}: {new_host['id']}")

        # If no clients remain in this room, clean up
        if not room_data['clients']:
            # Delete the uploaded song if any
            current_song = room_data.get('current_song')
            if current_song:
                song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
                if os.path.exists(song_path):
                    try:
                        os.remove(song_path)
                        logger.info(f"✅ Deleted song after session: {song_path}")
                    except Exception as e:
                        logger.error(f"⚠️ Error deleting song {song_path}: {e}")
            
            # Clean up Redis
            if redis_client:
                try:
                    redis_client.delete(f"room:{room_id}")
                except Exception as e:
                    logger.warning(f"Failed to clean Redis room data: {e}")
            
            # Remove the room from memory
            del rooms[room_id]
            logger.info(f"Room cleaned up: {room_id}")

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 10000)))