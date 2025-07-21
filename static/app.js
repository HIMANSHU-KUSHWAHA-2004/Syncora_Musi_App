class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.audio.playbackRate = 1.0;
        this.syncThreshold = 0.2; // 200ms sync threshold (more reasonable)
        
        // Synchronization state
        this.lastSyncTime = 0;
        this.syncInterval = null;
        this.pendingSeek = false;
        this.serverTimeOffset = 0;
        
        // Debounce for sync events
        this.syncDebounceTimeout = null;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.calculateServerTimeOffset();
    }

    // Calculate server time offset for better sync
    async calculateServerTimeOffset() {
        try {
            const measurements = [];
            
            // Take multiple measurements for accuracy
            for (let i = 0; i < 3; i++) {
                const start = Date.now();
                const response = await fetch('/api/time');
                const end = Date.now();
                const data = await response.json();
                
                const networkDelay = (end - start) / 2;
                const offset = data.server_time - (start + networkDelay);
                measurements.push(offset);
                
                // Small delay between measurements
                if (i < 2) await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // Use median to avoid outliers
            measurements.sort((a, b) => a - b);
            this.serverTimeOffset = measurements[1];
            console.log('Server time offset calculated:', this.serverTimeOffset, 'ms');
            
        } catch (error) {
            console.warn('Could not calculate server time offset:', error);
            this.serverTimeOffset = 0;
        }
    }

    getServerTime() {
        return Date.now() + this.serverTimeOffset;
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
            console.log('Audio metadata loaded, duration:', this.audio.duration);
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && !this.pendingSeek) {
                this.broadcastSeek();
            }
            this.pendingSeek = false;
        });

        this.audio.addEventListener('waiting', () => {
            console.log('Audio buffering...');
        });

        this.audio.addEventListener('canplay', () => {
            console.log('Audio can play');
        });

        this.audio.addEventListener('error', (e) => {
            console.error('Audio error:', e);
            this.showError('Audio playback error occurred');
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
            this.startSyncLoop();
        });

        this.socket.on('room_joined', (data) => {
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();

            if (data.current_song) {
                this.loadSong(data.current_song).then(() => {
                    // 🔧 FIX: Add delay and validation before syncing
                    setTimeout(() => {
                        if (this.audio.duration && !isNaN(this.audio.duration)) {
                            this.syncToState(data);
                        } else {
                            console.warn('Audio not ready for sync, retrying...');
                            // Retry sync after audio is loaded
                            this.audio.addEventListener('loadeddata', () => {
                                this.syncToState(data);
                            }, { once: true });
                        }
                    }, 200); // Small delay to ensure audio is ready
                }).catch(error => {
                    console.error('Error loading song:', error);
                });
            }

            if (this.isHost) {
                this.startSyncLoop();
            }
        });

        this.socket.on('join_error', (data) => {
            this.showError(data.message);
        });

        this.socket.on('song_changed', (data) => {
            this.loadSong(data.song).then(() => {
                // 🔧 FIX: Ensure audio is fully loaded before syncing
                setTimeout(() => {
                    if (this.audio.duration && !isNaN(this.audio.duration)) {
                        this.syncToState(data);
                    }
                }, 300);
            }).catch(error => {
                console.error('Error loading new song:', error);
            });
        });

        this.socket.on('sync_playback', (data) => {
            if (this.isHost) return; // Host doesn't sync to others

            this.syncToState(data);
        });

        this.socket.on('sync_seek', (data) => {
            // 🔧 FIX: Validate seek position before applying
            if (data.position >= 0 && data.position <= this.audio.duration) {
                this.pendingSeek = true;
                this.audio.currentTime = data.position;
                console.log('Synced seek to position:', data.position);
            } else {
                console.warn('Invalid seek position received:', data.position, 'Duration:', this.audio.duration);
            }
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent =
                `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            const wasHost = this.isHost;
            this.isHost = data.is_host;
            this.updateHostControls();
            
            if (this.isHost && !wasHost) {
                this.startSyncLoop();
            } else if (!this.isHost && wasHost) {
                this.stopSyncLoop();
            }
        });

        // Handle disconnection
        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.stopSyncLoop();
        });

        this.socket.on('reconnect', () => {
            console.log('Reconnected to server');
            if (this.currentRoom) {
                // Rejoin room on reconnect
                this.socket.emit('rejoin_room', { room_id: this.currentRoom });
            }
        });
    }

    // Sync to a given state from server
    syncToState(data) {
        if (!this.audio.src || !this.audio.duration) return;

        const currentTime = this.getServerTime();
        let targetPosition = data.position;

        // If we have timestamp data, calculate where we should be now
        if (data.timestamp && data.is_playing) {
            const timeDiff = (currentTime - data.timestamp) / 1000;
            targetPosition += timeDiff;
        }

        // 🔧 CRITICAL FIX: Prevent jumping beyond song duration
        if (targetPosition > this.audio.duration) {
            console.warn(`Target position ${targetPosition.toFixed(2)} exceeds duration ${this.audio.duration.toFixed(2)}, clamping`);
            targetPosition = this.audio.duration - 0.1; // Small buffer
        }
        
        if (targetPosition < 0) {
            console.warn(`Target position ${targetPosition.toFixed(2)} is negative, setting to 0`);
            targetPosition = 0;
        }

        // Only sync if we're significantly off
        const timeDifference = Math.abs(this.audio.currentTime - targetPosition);
        
        if (timeDifference > this.syncThreshold) {
            console.log(`Syncing: Current=${this.audio.currentTime.toFixed(2)}, Target=${targetPosition.toFixed(2)}, Diff=${timeDifference.toFixed(2)}, Duration=${this.audio.duration.toFixed(2)}`);
            this.pendingSeek = true;
            this.audio.currentTime = targetPosition;
        }

        // Sync play state
        if (data.is_playing && this.audio.paused) {
            this.audio.play().catch(e => console.error('Play failed:', e));
            this.updatePlayButton(true);
        } else if (!data.is_playing && !this.audio.paused) {
            this.audio.pause();
            this.updatePlayButton(false);
        }
    }

    // Start periodic sync for host
    startSyncLoop() {
        if (!this.isHost) return;
        
        this.stopSyncLoop(); // Clear any existing loop
        
        this.syncInterval = setInterval(() => {
            if (this.currentRoom && this.audio.src && !this.audio.paused) {
                this.broadcastSync();
            }
        }, 1000); // Sync every second for smooth experience
    }

    stopSyncLoop() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    // Broadcast current playback state
    broadcastSync() {
        if (!this.isHost || !this.audio.duration || isNaN(this.audio.duration)) return;

        // 🔧 FIX: Validate position before broadcasting
        let position = this.audio.currentTime;
        if (position > this.audio.duration) {
            position = this.audio.duration - 0.1;
            this.audio.currentTime = position;
        }

        const syncData = {
            room_id: this.currentRoom,
            position: position,
            is_playing: !this.audio.paused,
            timestamp: this.getServerTime(),
            duration: this.audio.duration // Include duration for validation
        };

        this.socket.emit('sync_playback', syncData);
        console.log('Broadcasting sync:', syncData);
    }

    // Broadcast seek position
    broadcastSeek() {
        if (!this.isHost) return;

        this.socket.emit('seek', {
            room_id: this.currentRoom,
            position: this.audio.currentTime,
            timestamp: this.getServerTime()
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
        this.stopSyncLoop();

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
        if (!this.isHost) return;

        this.audio.play().then(() => {
            this.updatePlayButton(true);
            this.broadcastSync();
        }).catch(e => {
            console.error('Play failed:', e);
            this.showError('Unable to play audio. Please try again.');
        });
    }

    pause() {
        if (!this.isHost) return;

        this.audio.pause();
        this.updatePlayButton(false);
        this.broadcastSync();
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

    async loadSong(filename) {
        return new Promise((resolve, reject) => {
            this.audio.src = `/static/uploads/${filename}`;
            this.audio.playbackRate = 1.0;
            
            const onLoad = () => {
                document.getElementById('song-name').textContent = filename.replace(/^\d+_/, '');
                this.audio.removeEventListener('loadeddata', onLoad);
                this.audio.removeEventListener('error', onError);
                resolve();
            };
            
            const onError = (e) => {
                this.audio.removeEventListener('loadeddata', onLoad);
                this.audio.removeEventListener('error', onError);
                reject(e);
            };

            this.audio.addEventListener('loadeddata', onLoad);
            this.audio.addEventListener('error', onError);
        });
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