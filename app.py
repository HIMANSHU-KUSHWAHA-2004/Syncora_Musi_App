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
import threading
from collections import deque  # for future buffering if needed

# ---------------- CONFIG ----------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'your-secret-key-change-in-production')
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB

# Ensure upload directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ---------------- REDIS -----------------
def create_redis_connection():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:jRcdJy754oYW00p8B1w6RwRf3mulP0go@red-d1uhscemcj7s73ehu9d0:6379')
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

# ---------------- SOCKET.IO ----------------
def create_socketio():
    redis_url = os.environ.get('REDIS_URL', 'redis://red-d1uhscemcj7s73ehu9d0:6379')
    if redis_url == 'none' or not redis_client:
        logger.warning("🔄 Running without Redis (single instance mode)")
        return SocketIO(app, cors_allowed_origins="*", ping_timeout=10, ping_interval=5)
    try:
        s = SocketIO(app, cors_allowed_origins="*", message_queue=redis_url,
                     ping_timeout=20, ping_interval=10)
        logger.info(f"✅ SocketIO connected with Redis: {redis_url}")
        return s
    except Exception as e:
        logger.error(f"⚠️ Redis connection failed, fallback to single instance: {e}")
        return SocketIO(app, cors_allowed_origins="*", ping_timeout=20, ping_interval=10)

socketio = create_socketio()

rooms = {}

# ---------------- HELPERS ----------------
def get_precise_timestamp():
    """High precision timestamp in ms."""
    return int(time.time_ns() // 1_000_000)

def store_room_state(room_id, room_data):
    if redis_client:
        try:
            redis_client.setex(f"room:{room_id}", 3600, str(room_data))
        except Exception as e:
            logger.warning(f"Failed to store room state in Redis: {e}")

def get_room_state(room_id):
    if redis_client:
        try:
            return redis_client.get(f"room:{room_id}")
        except Exception as e:
            logger.warning(f"Failed to get room state from Redis: {e}")
    return None

def emit_with_retry(event, data, room=None, retries=3):
    for attempt in range(retries):
        try:
            if room:
                emit(event, data, room=room)
            else:
                emit(event, data)
            break
        except Exception as e:
            logger.warning(f"Emit failed (attempt {attempt+1}): {e}")
            if attempt == retries-1:
                logger.error(f"Failed to emit {event} after {retries} attempts")

# ---------------- HEARTBEAT THREAD ----------------
def start_sync_heartbeat():
    """Send periodic sync updates to keep everyone aligned."""
    def sync_heartbeat():
        while True:
            try:
                current_time = get_precise_timestamp()
                for room_id, room_data in rooms.items():
                    if room_data.get('clients') and len(room_data['clients']) > 1:
                        if room_data['is_playing'] and room_data['play_start_time']:
                            elapsed = (current_time - room_data['play_start_time']) / 1000.0
                            current_position = room_data['position'] + elapsed
                            sync_data = {
                                'position': current_position,
                                'is_playing': room_data['is_playing'],
                                'timestamp': current_time,
                                'play_start_time': room_data['play_start_time'],
                                'server_position': current_position
                            }
                            try:
                                socketio.emit('heartbeat_sync', sync_data, room=room_id)
                            except Exception as e:
                                logger.warning(f"Failed heartbeat to room {room_id}: {e}")
                time.sleep(0.5)
            except Exception as e:
                logger.error(f"Heartbeat thread error: {e}")
                time.sleep(1)
    threading.Thread(target=sync_heartbeat, daemon=True).start()

# ---------------- ROUTES ----------------
@app.route('/')
def index():
    return render_template('index.html')

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

ALLOWED_EXTENSIONS = {'mp3','wav','ogg','m4a','flac'}
def allowed_file(fname): return '.' in fname and fname.rsplit('.',1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files: return jsonify({'error':'No file selected'})
    file = request.files['file']
    room_id = request.form.get('room_id')
    if file.filename == '': return jsonify({'error':'No file selected'})
    if file and allowed_file(file.filename):
        filename = f"{int(time.time())}_{secure_filename(file.filename)}"
        path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(path)
        if room_id in rooms:
            timestamp = get_precise_timestamp()
            rooms[room_id].update({
                'current_song': filename,
                'position': 0,
                'is_playing': False,
                'last_update': timestamp
            })
            store_room_state(room_id, rooms[room_id])
            socketio.emit('song_changed', {
                'song': filename,
                'position': 0,
                'is_playing': False,
                'timestamp': timestamp
            }, room=room_id)
        return jsonify({'success': True, 'filename': filename})
    return jsonify({'error':'Invalid file type'})

@app.route('/end_session', methods=['POST'])
def end_session():
    data = request.get_json()
    room_id = data.get('room_id')
    if not room_id or room_id not in rooms: return jsonify({'error':'Room not found'})
    current_song = rooms[room_id].get('current_song')
    if current_song:
        song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
        if os.path.exists(song_path):
            try:
                os.remove(song_path)
                if redis_client:
                    try: redis_client.delete(f"room:{room_id}")
                    except Exception as e: logger.warning(f"Redis clean error: {e}")
                return jsonify({'success':True})
            except Exception as e:
                return jsonify({'error':str(e)})
    return jsonify({'success':True})

@app.route('/sync_time')
def sync_time(): return jsonify({'server_time': get_precise_timestamp()})

# ---------------- SOCKET EVENTS ----------------
@socketio.on('ping_sync')
def handle_ping_sync():
    emit('pong_sync', {'server_time': get_precise_timestamp()})

@socketio.on('create_room')
def handle_create_room(data):
    room_id = str(uuid.uuid4())[:8]
    password = data.get('password','')
    timestamp = get_precise_timestamp()
    rooms[room_id] = {
        'host': request.sid,
        'password': password,
        'clients': [{'id':request.sid,'is_host':True,'latency':0}],
        'current_song': None,
        'position': 0,
        'is_playing': False,
        'last_update': timestamp,
        'play_start_time': None
    }
    join_room(room_id)
    store_room_state(room_id, rooms[room_id])
    emit('room_created', {'room_id':room_id,'is_host':True,'server_time':timestamp})
    logger.info(f"Room created: {room_id}")

@socketio.on('join_room')
def handle_join_room(data):
    room_id = data.get('room_id')
    password = data.get('password','')
    if room_id not in rooms: return emit('join_error',{'message':'Room not found'})
    if rooms[room_id]['password'] != password: return emit('join_error',{'message':'Incorrect password'})
    join_room(room_id)
    timestamp = get_precise_timestamp()
    rooms[room_id]['clients'].append({'id':request.sid,'is_host':False,'latency':0})
    store_room_state(room_id, rooms[room_id])
    current_position = rooms[room_id]['position']
    if rooms[room_id]['is_playing'] and rooms[room_id]['play_start_time']:
        elapsed = (timestamp - rooms[room_id]['play_start_time'])/1000.0
        current_position += elapsed
    emit('room_joined',{
        'room_id':room_id,
        'is_host':False,
        'current_song':rooms[room_id]['current_song'],
        'position':current_position,
        'is_playing':rooms[room_id]['is_playing'],
        'server_time':timestamp,
        'last_update':rooms[room_id]['last_update']
    })
    emit_with_retry('clients_updated',{'clients':len(rooms[room_id]['clients'])},room=room_id)

@socketio.on('update_latency')
def handle_update_latency(data):
    room_id = data.get('room_id'); latency = data.get('latency',0)
    if room_id in rooms:
        for c in rooms[room_id]['clients']:
            if c['id']==request.sid:
                c['latency']=latency; break

# 🔥 Enhanced play/pause
@socketio.on('play_pause')
def handle_play_pause(data):
    room_id = data.get('room_id')
    if room_id not in rooms or rooms[room_id]['host'] != request.sid: return
    timestamp = get_precise_timestamp()
    is_playing = data.get('is_playing'); position = data.get('position',0)
    rooms[room_id]['is_playing']=is_playing
    rooms[room_id]['position']=position
    rooms[room_id]['last_update']=timestamp
    rooms[room_id]['play_start_time'] = timestamp if is_playing else None
    store_room_state(room_id, rooms[room_id])
    sync_data = {
        'is_playing':is_playing,
        'position':position,
        'timestamp':timestamp,
        'play_start_time':rooms[room_id]['play_start_time'],
        'server_position':position,
        'sync_type':'play_pause'
    }
    emit_with_retry('sync_playbook',sync_data,room=room_id)

# 🔥 Enhanced seek
@socketio.on('seek')
def handle_seek(data):
    room_id = data.get('room_id')
    if room_id not in rooms or rooms[room_id]['host'] != request.sid: return
    timestamp = get_precise_timestamp()
    position = data.get('position',0)
    rooms[room_id]['position']=position
    rooms[room_id]['last_update']=timestamp
    if rooms[room_id]['is_playing']: rooms[room_id]['play_start_time']=timestamp
    store_room_state(room_id, rooms[room_id])
    sync_data = {
        'position':position,
        'timestamp':timestamp,
        'is_playing':rooms[room_id]['is_playing'],
        'play_start_time':rooms[room_id]['play_start_time'],
        'server_position':position,
        'sync_type':'seek'
    }
    emit_with_retry('sync_seek',sync_data,room=room_id)

# ✨ New sync_check
@socketio.on('sync_check')
def handle_sync_check(data):
    room_id = data.get('room_id')
    client_position = data.get('client_position',0)
    if room_id not in rooms: return
    timestamp = get_precise_timestamp()
    room_data = rooms[room_id]
    server_position = room_data['position']
    if room_data['is_playing'] and room_data['play_start_time']:
        elapsed = (timestamp-room_data['play_start_time'])/1000.0
        server_position = room_data['position']+elapsed
    position_diff = abs(client_position-server_position)
    if position_diff>0.2:
        sync_data = {
            'position':room_data['position'],
            'timestamp':timestamp,
            'is_playing':room_data['is_playing'],
            'play_start_time':room_data['play_start_time'],
            'server_position':server_position,
            'sync_type':'correction',
            'position_diff':position_diff
        }
        emit('force_sync',sync_data)

@socketio.on('request_sync')
def handle_request_sync(data):
    room_id = data.get('room_id')
    if room_id not in rooms: return
    room_data = rooms[room_id]
    timestamp = get_precise_timestamp()
    current_position = room_data['position']
    if room_data['is_playing'] and room_data['play_start_time']:
        elapsed = (timestamp - room_data['play_start_time'])/1000.0
        current_position += elapsed
    emit('force_sync',{
        'position':current_position,
        'is_playing':room_data['is_playing'],
        'timestamp':timestamp,
        'play_start_time':room_data['play_start_time']
    })

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    for room_id in list(rooms.keys()):
        room_data = rooms[room_id]
        rooms[room_id]['clients']=[c for c in room_data['clients'] if c['id']!=request.sid]
        if room_data['host']==request.sid:
            if room_data['clients']:
                new_host = room_data['clients'][0]
                rooms[room_id]['host']=new_host['id']
                new_host['is_host']=True
                store_room_state(room_id,rooms[room_id])
                emit('new_host',{'is_host':True},room=new_host['id'])
        if not room_data['clients']:
            current_song = room_data.get('current_song')
            if current_song:
                path = os.path.join(app.config['UPLOAD_FOLDER'],current_song)
                if os.path.exists(path):
                    try: os.remove(path)
                    except Exception as e: logger.error(f"Error deleting {path}: {e}")
            if redis_client:
                try: redis_client.delete(f"room:{room_id}")
                except Exception as e: logger.warning(f"Redis delete error: {e}")
            del rooms[room_id]

# ---------------- START ----------------
start_sync_heartbeat()

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT',10000)))
