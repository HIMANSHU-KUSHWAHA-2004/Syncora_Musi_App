class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.audio.playbackRate = 1.0;
        this.syncThreshold = 0.3; // More lenient threshold
        
        // Simple sync control
        this.isSyncing = false;
        this.lastSyncTime = 0;
        this.syncCooldown = 1000; // 1 second cooldown
        this.isManualSeek = false;
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
    }

    setupEventListeners() {
        // Navigation
        document.getElementById('create-room-btn').addEventListener('click', () => {
            this.showScreen('create-room-screen');
        });

        document.getElementById('back-btn').addEventListener('click', () => {
            this.showScreen('home-screen');
        });

        document.getElementById('confirm-create-btn').addEventListener('click', () => {
            this.createRoom();
        });

        document.getElementById('join-room-btn').addEventListener('click', () => {
            this.joinRoom();
        });

        document.getElementById('leave-room-btn').addEventListener('click', () => {
            this.leaveRoom();
        });

        // Audio controls
        document.getElementById('play-btn').addEventListener('click', () => {
            this.play();
        });

        document.getElementById('pause-btn').addEventListener('click', () => {
            this.pause();
        });

        // File upload
        document.getElementById('upload-btn').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        document.getElementById('file-input').addEventListener('change', (e) => {
            this.uploadFile(e.target.files[0]);
        });

        // Audio events
        this.audio.addEventListener('loadedmetadata', () => {
            this.updateTimeDisplay();
            this.audio.playbackRate = 1.0;
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('seeking', () => {
            this.isManualSeek = true;
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && this.isManualSeek && !this.isSyncing) {
                this.socket.emit('seek', {
                    room_id: this.currentRoom,
                    position: this.audio.currentTime
                });
            }
            this.isManualSeek = false;
        });

        // Error modal
        document.getElementById('close-error-btn').addEventListener('click', () => {
            this.hideModal();
        });

        // Enter key support
        document.getElementById('room-id-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });

        document.getElementById('room-password-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });

        document.getElementById('new-room-password').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.createRoom();
        });
    }

    setupSocketEvents() {
        this.socket.on('room_created', (data) => {
            console.log('Room created:', data);
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();
        });

        this.socket.on('room_joined', (data) => {
            console.log('Room joined:', data);
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();

            if (data.current_song) {
                this.loadSong(data.current_song);
                this.syncToPosition(data.position, data.is_playing);
            }
        });

        this.socket.on('join_error', (data) => {
            console.log('Join error:', data);
            this.showError(data.message);
        });

        this.socket.on('song_changed', (data) => {
            console.log('Song changed:', data);
            this.loadSong(data.song);
            this.syncToPosition(data.position, data.is_playing);
        });

        this.socket.on('sync_playback', (data) => {
            if (this.isHost) return; // Host doesn't sync to itself
            
            console.log('Sync playback received:', data);
            const now = Date.now();
            if (now - this.lastSyncTime < this.syncCooldown) {
                console.log('Sync skipped - cooldown active');
                return;
            }
            
            this.syncToPosition(data.position, data.is_playing);
        });

        this.socket.on('sync_seek', (data) => {
            if (this.isHost) return; // Host doesn't sync to itself
            console.log('Sync seek received:', data);
            this.syncToPosition(data.position, null);
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent =
                `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            console.log('New host assigned:', data);
            this.isHost = data.is_host;
            this.updateHostControls();
        });

        // Add error handling
        this.socket.on('connect', () => {
            console.log('Connected to server');
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
        });

        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
        });
    }

    // Simplified sync method
    syncToPosition(targetPosition, shouldPlay = null) {
        if (this.isSyncing) {
            console.log('Sync blocked - already syncing');
            return;
        }
        
        if (!this.audio || !this.currentRoom) {
            console.log('Sync blocked - no audio or room');
            return;
        }
        
        try {
            this.isSyncing = true;
            this.lastSyncTime = Date.now();
            
            const currentPos = this.audio.currentTime || 0;
            const timeDiff = Math.abs(currentPos - targetPosition);
            
            console.log(`Sync attempt: Current=${currentPos.toFixed(2)}s, Target=${targetPosition.toFixed(2)}s, Diff=${timeDiff.toFixed(3)}s`);
            
            // Only sync if difference is significant
            if (timeDiff > this.syncThreshold) {
                console.log('Performing sync - difference exceeds threshold');
                this.audio.currentTime = targetPosition;
            }
            
            this.audio.playbackRate = 1.0;
            
            // Handle play/pause state
            if (shouldPlay !== null) {
                if (shouldPlay && this.audio.paused) {
                    console.log('Starting playback');
                    this.audio.play().then(() => {
                        this.updatePlayButton(true);
                    }).catch(error => {
                        console.error('Play failed:', error);
                    });
                } else if (!shouldPlay && !this.audio.paused) {
                    console.log('Pausing playback');
                    this.audio.pause();
                    this.updatePlayButton(false);
                }
            }
            
        } catch (error) {
            console.error('Sync error:', error);
        } finally {
            // Reset sync flag after delay
            setTimeout(() => {
                this.isSyncing = false;
                console.log('Sync flag reset');
            }, 200);
        }
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }

    createRoom() {
        const password = document.getElementById('new-room-password').value;
        console.log('Creating room...');
        this.socket.emit('create_room', { password });
    }

    joinRoom() {
        const roomId = document.getElementById('room-id-input').value.trim();
        const password = document.getElementById('room-password-input').value;

        if (!roomId) {
            this.showError('Please enter a room ID');
            return;
        }

        console.log('Joining room:', roomId);
        this.socket.emit('join_room', {
            room_id: roomId,
            password: password
        });
    }

    leaveRoom() {
        console.log('Leaving room...');
        
        if (this.isHost && this.currentRoom) {
            fetch('/end_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: this.currentRoom })
            })
                .then(res => res.json())
                .then(data => {
                    console.log('✅ Cleanup result:', data);
                })
                .catch(err => console.error('❌ Error cleaning up session:', err));
        }

        this.currentRoom = null;
        this.isHost = false;
        this.isSyncing = false;
        this.audio.pause();
        this.audio.src = '';
        this.showScreen('home-screen');

        document.getElementById('room-id-input').value = '';
        document.getElementById('room-password-input').value = '';
        document.getElementById('new-room-password').value = '';
    }

    showPlayer() {
        this.showScreen('player-screen');
        document.getElementById('room-id-display').textContent = `Room: ${this.currentRoom}`;
        this.updateHostControls();
    }

    updateHostControls() {
        const hostControls = document.getElementById('host-controls');
        const hostBadge = document.getElementById('host-badge');

        if (this.isHost) {
            hostControls.style.display = 'block';
            hostBadge.style.display = 'inline';
        } else {
            hostControls.style.display = 'none';
            hostBadge.style.display = 'none';
        }
    }

    play() {
        if (!this.isHost) {
            console.log('Play blocked - not host');
            return;
        }

        console.log('Host starting playback');
        this.audio.playbackRate = 1.0;
        this.audio.play().then(() => {
            this.updatePlayButton(true);
            this.socket.emit('play_pause', {
                room_id: this.currentRoom,
                is_playing: true,
                position: this.audio.currentTime
            });
            console.log('Play command sent to server');
        }).catch(error => {
            console.error('Play failed:', error);
        });
    }

    pause() {
        if (!this.isHost) {
            console.log('Pause blocked - not host');
            return;
        }

        console.log('Host pausing playback');
        this.audio.pause();
        this.updatePlayButton(false);

        this.socket.emit('play_pause', {
            room_id: this.currentRoom,
            is_playing: false,
            position: this.audio.currentTime
        });
        console.log('Pause command sent to server');
    }

    updatePlayButton(isPlaying) {
        const playBtn = document.getElementById('play-btn');
        const pauseBtn = document.getElementById('pause-btn');

        if (isPlaying) {
            playBtn.style.display = 'none';
            pauseBtn.style.display = 'inline-block';
        } else {
            playBtn.style.display = 'inline-block';
            pauseBtn.style.display = 'none';
        }
    }

    loadSong(filename) {
        console.log('Loading song:', filename);
        this.audio.src = `/static/uploads/${filename}`;
        this.audio.playbackRate = 1.0;
        document.getElementById('song-name').textContent = filename.replace(/^\d+_/, '');
    }

    updateTimeDisplay() {
        const current = this.formatTime(this.audio.currentTime);
        const duration = this.formatTime(this.audio.duration);
        document.getElementById('time-display').textContent = `${current} / ${duration}`;
    }

    formatTime(seconds) {
        if (isNaN(seconds)) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    uploadFile(file) {
        if (!file || !this.isHost) return;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('room_id', this.currentRoom);

        const status = document.getElementById('upload-status');
        status.textContent = 'Uploading...';
        status.className = '';

        fetch('/upload', {
            method: 'POST',
            body: formData
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    status.textContent = 'Upload successful!';
                    status.className = 'success';
                    document.getElementById('file-input').value = '';
                } else {
                    status.textContent = data.error || 'Upload failed';
                    status.className = 'error';
                }

                setTimeout(() => {
                    status.textContent = '';
                    status.className = '';
                }, 3000);
            })
            .catch(error => {
                status.textContent = 'Upload failed';
                status.className = 'error';
                setTimeout(() => {
                    status.textContent = '';
                    status.className = '';
                }, 3000);
            });
    }

    showError(message) {
        document.getElementById('error-message').textContent = message;
        document.getElementById('error-modal').classList.add('active');
    }

    hideModal() {
        document.getElementById('error-modal').classList.remove('active');
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    new SyncMusicPlayer();
});