from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import os
import uuid
from werkzeug.utils import secure_filename
import time

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key'
app.config['UPLOAD_FOLDER'] = 'static/uploads'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max file size

# Ensure upload directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# Store room data
rooms = {}
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
            
            # Notify all clients in room
            socketio.emit('song_changed', {
                'song': filename,
                'position': 0,
                'is_playing': False
            }, room=room_id)
        
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
                print(f"✅ Deleted song after session: {song_path}")
                return jsonify({'success': True, 'message': 'Session cleaned up successfully'})
            except Exception as e:
                print(f"⚠️ Error deleting song {song_path}: {e}")
                return jsonify({'error': f'Error deleting file: {str(e)}'})
    
    return jsonify({'success': True, 'message': 'No files to clean up'})

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
    
    emit('room_created', {
        'room_id': room_id,
        'is_host': True
    })

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
    
    # Send current state to new client
    emit('room_joined', {
        'room_id': room_id,
        'is_host': False,
        'current_song': rooms[room_id]['current_song'],
        'position': rooms[room_id]['position'],
        'is_playing': rooms[room_id]['is_playing']
    })
    
    # Update client list for all users
    emit('clients_updated', {
        'clients': len(rooms[room_id]['clients'])
    }, room=room_id)

@socketio.on('play_pause')
def handle_play_pause(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    rooms[room_id]['is_playing'] = data.get('is_playing')
    rooms[room_id]['position'] = data.get('position', 0)
    rooms[room_id]['last_update'] = time.time()
    
    emit('sync_playback', {
        'is_playing': rooms[room_id]['is_playing'],
        'position': rooms[room_id]['position'],
        'timestamp': rooms[room_id]['last_update']
    }, room=room_id, include_self=False)

@socketio.on('seek')
def handle_seek(data):
    room_id = data.get('room_id')
    
    if room_id not in rooms or rooms[room_id]['host'] != request.sid:
        return
    
    rooms[room_id]['position'] = data.get('position', 0)
    rooms[room_id]['last_update'] = time.time()
    
    emit('sync_seek', {
        'position': rooms[room_id]['position'],
        'timestamp': rooms[room_id]['last_update']
    }, room=room_id, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
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
                emit('new_host', {'is_host': True}, room=new_host['id'])

        # If no clients remain in this room, clean up
        if not room_data['clients']:
            # Delete the uploaded song if any
            current_song = room_data.get('current_song')
            if current_song:
                song_path = os.path.join(app.config['UPLOAD_FOLDER'], current_song)
                if os.path.exists(song_path):
                    try:
                        os.remove(song_path)
                        print(f"✅ Deleted song after session: {song_path}")
                    except Exception as e:
                        print(f"⚠️ Error deleting song {song_path}: {e}")
            # Remove the room from memory
            del rooms[room_id]
   

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=10000)
