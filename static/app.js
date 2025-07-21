class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.audio.playbackRate = 1.0;

        this.syncThreshold = 0.1; // 100ms
        this.lastSyncTime = 0;
        this.syncInterval = null;
        this.pendingSeek = false;
        this.serverTimeOffset = 0;
        this.offsetRecalcInterval = null;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.calculateServerTimeOffset();
        this.offsetRecalcInterval = setInterval(() => {
            this.calculateServerTimeOffset();
        }, 30000);
    }

    async calculateServerTimeOffset() {
        try {
            const start = Date.now();
            const response = await fetch('/api/time');
            const end = Date.now();
            const data = await response.json();

            const networkDelay = (end - start) / 2;
            this.serverTimeOffset = data.server_time - (start + networkDelay);
        } catch (error) {
            console.warn('Could not calculate server time offset:', error);
            this.serverTimeOffset = 0;
        }
    }

    getServerTime() {
        return Date.now() + this.serverTimeOffset;
    }

    setupEventListeners() {
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

        document.getElementById('play-btn').addEventListener('click', () => {
            this.play();
        });

        document.getElementById('pause-btn').addEventListener('click', () => {
            this.pause();
        });

        document.getElementById('upload-btn').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        document.getElementById('file-input').addEventListener('change', (e) => {
            this.uploadFile(e.target.files[0]);
        });

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

        document.getElementById('close-error-btn').addEventListener('click', () => {
            this.hideModal();
        });

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
                    this.audio.addEventListener('canplay', () => {
                        this.syncToState(data);
                    }, { once: true });
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
                this.audio.addEventListener('canplay', () => {
                    this.syncToState(data);
                }, { once: true });
            });
        });

        this.socket.on('sync_playback', (data) => {
            if (this.isHost) return;
            this.syncToState(data);
        });

        this.socket.on('sync_seek', (data) => {
            this.pendingSeek = true;
            this.audio.currentTime = data.position;
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

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.stopSyncLoop();
        });

        this.socket.on('reconnect', () => {
            console.log('Reconnected to server');
            if (this.currentRoom) {
                this.socket.emit('rejoin_room', { room_id: this.currentRoom });
            }
        });
    }

    syncToState(data) {
        if (!this.audio.src) return;

        const currentTime = this.getServerTime();
        let targetPosition = data.position;

        if (data.timestamp && data.is_playing) {
            const timeDiff = (currentTime - data.timestamp) / 1000;
            targetPosition += timeDiff;
        }

        const diff = targetPosition - this.audio.currentTime;

        if (Math.abs(diff) > this.syncThreshold) {
            this.pendingSeek = true;
            this.audio.currentTime = targetPosition;
        } else {
            if (!this.audio.paused && data.is_playing) {
                const adjust = diff * 0.05;
                this.audio.playbackRate = 1.0 + adjust;
                clearTimeout(this._resetRateTimer);
                this._resetRateTimer = setTimeout(() => {
                    this.audio.playbackRate = 1.0;
                }, 200);
            }
        }

        if (data.is_playing && this.audio.paused) {
            this.audio.play().catch(e => console.error('Play failed:', e));
            this.updatePlayButton(true);
        } else if (!data.is_playing && !this.audio.paused) {
            this.audio.pause();
            this.updatePlayButton(false);
        }
    }

    startSyncLoop() {
        if (!this.isHost) return;
        this.stopSyncLoop();
        this.syncInterval = setInterval(() => {
            if (this.currentRoom && this.audio.src) {
                this.broadcastSync();
            }
        }, 250);
    }

    stopSyncLoop() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    broadcastSync() {
        if (!this.isHost) return;
        const syncData = {
            room_id: this.currentRoom,
            position: this.audio.currentTime,
            is_playing: !this.audio.paused,
            timestamp: this.getServerTime()
        };
        this.socket.emit('sync_playback', syncData);
    }

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
        this.socket.emit('join_room', { room_id: roomId, password: password });
    }

    leaveRoom() {
        this.stopSyncLoop();
        if (this.isHost && this.currentRoom) {
            fetch('/end_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: this.currentRoom })
            }).catch(err => console.error('❌ Error cleaning up session:', err));
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

document.addEventListener('DOMContentLoaded', () => {
    new SyncMusicPlayer();
});
