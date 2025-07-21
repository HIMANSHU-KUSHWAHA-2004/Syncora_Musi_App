class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.syncThreshold = 0.2; // Reduced to 200ms for better sync
        this.serverTimeOffset = 0; // Offset between client and server time
        this.latency = 0; // Network latency
        this.syncInterval = null; // For periodic sync checks
        this.lastSyncTime = 0;
        this.playStartTime = null; // When the current play session started
        this.targetPosition = 0; // Target position for sync
        this.isSyncing = false; // Flag to prevent sync loops

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.measureLatencyPeriodically();
        this.syncTimeWithServer();
    }

    // Measure latency to server periodically
    measureLatencyPeriodically() {
        setInterval(() => {
            this.measureLatency();
        }, 5000); // Every 5 seconds
    }

    measureLatency() {
        const start = performance.now();
        this.socket.emit('ping_sync');
        
        this.socket.once('pong_sync', (data) => {
            const end = performance.now();
            this.latency = (end - start) / 2; // Round trip time / 2
            
            // Update server time offset
            const serverTime = data.server_time;
            const clientTime = Date.now();
            this.serverTimeOffset = serverTime - clientTime;
            
            // Send latency to server
            if (this.currentRoom) {
                this.socket.emit('update_latency', {
                    room_id: this.currentRoom,
                    latency: this.latency
                });
            }
        });
    }

    // Get server time adjusted for latency
    getServerTime() {
        return Date.now() + this.serverTimeOffset;
    }

    // Sync time with server on initialization
    syncTimeWithServer() {
        fetch('/sync_time')
            .then(res => res.json())
            .then(data => {
                const clientTime = Date.now();
                this.serverTimeOffset = data.server_time - clientTime;
            })
            .catch(err => console.warn('Failed to sync time with server:', err));
    }

    // Calculate precise position based on server timing
    calculatePrecisePosition(basePosition, isPlaying, playStartTime) {
        if (!isPlaying || !playStartTime) {
            return basePosition;
        }
        
        const currentServerTime = this.getServerTime();
        const elapsed = (currentServerTime - playStartTime) / 1000.0;
        return Math.max(0, basePosition + elapsed);
    }

    // Enhanced sync function with better timing
    syncToPosition(targetData, forceSync = false) {
        if (this.isSyncing && !forceSync) return;
        
        const { position, is_playing, timestamp, play_start_time } = targetData;
        const currentServerTime = this.getServerTime();
        
        // Calculate the actual target position accounting for time passed
        let targetPosition = position;
        if (is_playing && play_start_time) {
            const elapsed = (currentServerTime - play_start_time) / 1000.0;
            targetPosition = Math.max(0, position + elapsed);
        }
        
        // Check if we need to sync
        const timeDiff = Math.abs(this.audio.currentTime - targetPosition);
        const needsSync = forceSync || timeDiff > this.syncThreshold;
        
        if (needsSync) {
            this.isSyncing = true;
            
            // Compensate for latency
            const latencyCompensation = this.latency / 1000.0;
            const compensatedPosition = Math.max(0, targetPosition + (is_playing ? latencyCompensation : 0));
            
            console.log(`Syncing: current=${this.audio.currentTime.toFixed(2)}, target=${compensatedPosition.toFixed(2)}, diff=${timeDiff.toFixed(2)}`);
            
            this.audio.currentTime = compensatedPosition;
            
            setTimeout(() => {
                this.isSyncing = false;
            }, 100);
        }
        
        // Handle play/pause state
        if (is_playing && this.audio.paused) {
            this.audio.play().catch(e => console.warn('Play failed:', e));
            this.updatePlayButton(true);
        } else if (!is_playing && !this.audio.paused) {
            this.audio.pause();
            this.updatePlayButton(false);
        }
        
        this.playStartTime = play_start_time;
        this.lastSyncTime = currentServerTime;
    }

    // Start periodic sync checks
    startPeriodicSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        this.syncInterval = setInterval(() => {
            if (this.currentRoom && !this.isHost) {
                // Request sync from server if we haven't synced recently
                const timeSinceLastSync = this.getServerTime() - this.lastSyncTime;
                if (timeSinceLastSync > 2000) { // 2 seconds
                    this.socket.emit('request_sync', { room_id: this.currentRoom });
                }
            }
        }, 1000); // Check every second
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

        // Audio events with improved handling
        this.audio.addEventListener('loadedmetadata', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && !this.isSyncing) {
                this.socket.emit('seek', {
                    room_id: this.currentRoom,
                    position: this.audio.currentTime
                });
            }
        });

        // Prevent accidental seeking for non-hosts
        this.audio.addEventListener('seeking', (e) => {
            if (!this.isHost && !this.isSyncing) {
                e.preventDefault();
                return false;
            }
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
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();
            this.startPeriodicSync();
        });

        this.socket.on('room_joined', (data) => {
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();

            if (data.current_song) {
                this.loadSong(data.current_song);
                
                // Initial sync with precise timing
                this.syncToPosition({
                    position: data.position,
                    is_playing: data.is_playing,
                    timestamp: data.server_time,
                    play_start_time: data.last_update
                }, true);
            }
            
            this.startPeriodicSync();
        });

        this.socket.on('join_error', (data) => {
            this.showError(data.message);
        });

        this.socket.on('song_changed', (data) => {
            this.loadSong(data.song);
            this.syncToPosition({
                position: data.position,
                is_playing: data.is_playing,
                timestamp: data.timestamp,
                play_start_time: null
            }, true);
        });

        this.socket.on('sync_playback', (data) => {
            console.log('Received sync_playback:', data);
            this.syncToPosition(data);
        });

        this.socket.on('sync_seek', (data) => {
            console.log('Received sync_seek:', data);
            this.syncToPosition(data, true);
        });

        this.socket.on('force_sync', (data) => {
            console.log('Received force_sync:', data);
            this.syncToPosition(data, true);
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent =
                `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            this.isHost = data.is_host;
            this.updateHostControls();
        });

        // Handle connection issues
        this.socket.on('disconnect', () => {
            console.warn('Disconnected from server');
            if (this.syncInterval) {
                clearInterval(this.syncInterval);
            }
        });

        this.socket.on('reconnect', () => {
            console.log('Reconnected to server');
            this.syncTimeWithServer();
            if (this.currentRoom) {
                this.startPeriodicSync();
                // Request immediate sync after reconnection
                setTimeout(() => {
                    this.socket.emit('request_sync', { room_id: this.currentRoom });
                }, 100);
            }
        });
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }

    createRoom() {
        const password = document.getElementById('new-room-password').value;
        this.socket.emit('create_room', { password });
    }

    joinRoom() {
        const roomId = document.getElementById('room-id-input').value.trim();
        const password = document.getElementById('room-password-input').value;

        if (!roomId) {
            this.showError('Please enter a room ID');
            return;
        }

        this.socket.emit('join_room', {
            room_id: roomId,
            password: password
        });
    }

    leaveRoom() {
        // Stop sync interval
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }

        // If host, call the cleanup endpoint
        if (this.isHost && this.currentRoom) {
            fetch('/end_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: this.currentRoom })
            })
                .then(res => res.json())
                .then(data => {
                    console.log('Cleanup result:', data);
                })
                .catch(err => console.error('Error cleaning up session:', err));
        }

        // Clear local state
        this.currentRoom = null;
        this.isHost = false;
        this.playStartTime = null;
        this.audio.pause();
        this.audio.src = '';
        this.showScreen('home-screen');

        // Clear inputs
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
        if (!this.isHost) return;

        this.audio.play().catch(e => console.warn('Play failed:', e));
        this.updatePlayButton(true);

        this.socket.emit('play_pause', {
            room_id: this.currentRoom,
            is_playing: true,
            position: this.audio.currentTime
        });
    }

    pause() {
        if (!this.isHost) return;

        this.audio.pause();
        this.updatePlayButton(false);

        this.socket.emit('play_pause', {
            room_id: this.currentRoom,
            is_playing: false,
            position: this.audio.currentTime
        });
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
        this.audio.src = `/static/uploads/${filename}`;
        document.getElementById('song-name').textContent = filename.replace(/^\d+_/, '');
    }

    updateTimeDisplay() {
        const current = this.formatTime(this.audio.currentTime);
        const duration = this.formatTime(this.audio.duration);
        document.getElementById('time-display').textContent = `${current} / ${duration}`;
        
        // Show sync status for debugging (remove in production)
        if (!this.isHost) {
            const syncStatus = document.getElementById('sync-status') || this.createSyncStatusElement();
            syncStatus.textContent = `Latency: ${this.latency.toFixed(0)}ms | Offset: ${this.serverTimeOffset.toFixed(0)}ms`;
        }
    }

    createSyncStatusElement() {
        const statusElement = document.createElement('div');
        statusElement.id = 'sync-status';
        statusElement.style.cssText = 'position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); color: white; padding: 5px; border-radius: 3px; font-size: 12px;';
        document.getElementById('player-screen').appendChild(statusElement);
        return statusElement;
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