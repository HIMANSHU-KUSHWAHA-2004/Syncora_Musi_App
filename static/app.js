class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.audio.playbackRate = 1.0;
        this.syncThreshold = 0.2; // Balanced threshold - not too sensitive, not too loose
        
        // Enhanced sync control
        this.isSyncing = false;
        this.lastSyncTime = 0;
        this.syncCooldown = 500; // Reduced cooldown for more frequent but controlled syncing
        this.isManualSeek = false;
        
        // Network latency compensation
        this.networkOffset = 0;
        this.pingInterval = null;
        this.lastPingTime = 0;
        
        // Sync monitoring for debugging
        this.syncStats = {
            totalSyncs: 0,
            avgDrift: 0,
            maxDrift: 0
        };
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.startNetworkLatencyMeasurement();
        this.startSyncMonitoring();
    }

    // Network latency measurement for better sync
    startNetworkLatencyMeasurement() {
        this.pingInterval = setInterval(() => {
            this.lastPingTime = Date.now();
            this.socket.emit('ping');
        }, 5000); // Ping every 5 seconds
    }

    // Continuous sync monitoring for non-hosts
    startSyncMonitoring() {
        if (!this.isHost) {
            setInterval(() => {
                if (this.currentRoom && !this.audio.paused) {
                    this.socket.emit('request_sync', {
                        room_id: this.currentRoom,
                        current_position: this.audio.currentTime
                    });
                }
            }, 2000); // Request sync every 2 seconds during playback
        }
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

        // Enhanced audio events
        this.audio.addEventListener('loadedmetadata', () => {
            this.updateTimeDisplay();
            this.audio.playbackRate = 1.0;
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
        });

        // Better seek handling
        this.audio.addEventListener('seeking', () => {
            this.isManualSeek = true;
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && this.isManualSeek && !this.isSyncing) {
                // Broadcast seek immediately with timestamp
                this.socket.emit('seek', {
                    room_id: this.currentRoom,
                    position: this.audio.currentTime,
                    timestamp: Date.now()
                });
            }
            this.isManualSeek = false;
        });

        // Handle audio stalling/buffering
        this.audio.addEventListener('waiting', () => {
            if (this.isHost) {
                this.socket.emit('host_buffering', {
                    room_id: this.currentRoom,
                    position: this.audio.currentTime
                });
            }
        });

        this.audio.addEventListener('canplaythrough', () => {
            if (this.isHost) {
                this.socket.emit('host_ready', {
                    room_id: this.currentRoom,
                    position: this.audio.currentTime
                });
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
        // Latency measurement
        this.socket.on('pong', () => {
            const latency = (Date.now() - this.lastPingTime) / 2;
            this.networkOffset = latency;
            console.log(`Network latency: ${latency}ms`);
        });

        this.socket.on('room_created', (data) => {
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();
        });

        this.socket.on('room_joined', (data) => {
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();

            if (data.current_song) {
                this.loadSong(data.current_song);
                // Enhanced initial sync with server timestamp
                this.performTimestampedSync(data.position, data.is_playing, data.timestamp);
            }
        });

        this.socket.on('join_error', (data) => {
            this.showError(data.message);
        });

        this.socket.on('song_changed', (data) => {
            this.loadSong(data.song);
            this.performTimestampedSync(data.position, data.is_playing, data.timestamp);
        });

        // Enhanced sync with timestamp compensation
        this.socket.on('sync_playback', (data) => {
            if (this.isHost) return;
            this.performTimestampedSync(data.position, data.is_playing, data.timestamp);
        });

        this.socket.on('sync_seek', (data) => {
            if (this.isHost) return;
            this.performTimestampedSync(data.position, null, data.timestamp);
        });

        // Handle buffering events
        this.socket.on('host_buffering', () => {
            if (!this.isHost && !this.audio.paused) {
                this.audio.pause();
                this.updatePlayButton(false);
            }
        });

        this.socket.on('host_ready', (data) => {
            if (!this.isHost) {
                this.performTimestampedSync(data.position, true, data.timestamp);
            }
        });

        // Continuous sync response
        this.socket.on('sync_response', (data) => {
            if (!this.isHost) {
                this.performGentleSync(data.position, data.is_playing);
            }
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent =
                `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            this.isHost = data.is_host;
            this.updateHostControls();
            if (this.isHost) {
                clearInterval(this.syncMonitorInterval);
            } else {
                this.startSyncMonitoring();
            }
        });
    }

    // Enhanced sync with timestamp compensation
    performTimestampedSync(targetPosition, shouldPlay, serverTimestamp) {
        if (this.isSyncing) return;
        
        this.isSyncing = true;
        this.lastSyncTime = Date.now();
        
        // Calculate time elapsed since server sent the position
        const networkDelay = this.networkOffset;
        const timeSinceUpdate = (Date.now() - serverTimestamp) / 1000;
        const compensatedPosition = targetPosition + timeSinceUpdate + (networkDelay / 1000);
        
        const currentPos = this.audio.currentTime;
        const timeDiff = Math.abs(currentPos - compensatedPosition);
        
        // Update sync statistics
        this.updateSyncStats(timeDiff);
        
        console.log(`Sync: Current=${currentPos.toFixed(2)}, Target=${compensatedPosition.toFixed(2)}, Diff=${timeDiff.toFixed(3)}s`);
        
        // Use different thresholds based on playback state
        const threshold = shouldPlay ? this.syncThreshold : this.syncThreshold * 0.5;
        
        if (timeDiff > threshold) {
            this.audio.currentTime = compensatedPosition;
        }
        
        this.audio.playbackRate = 1.0;
        
        if (shouldPlay !== null) {
            if (shouldPlay && this.audio.paused) {
                this.audio.play().catch(console.error);
                this.updatePlayButton(true);
            } else if (!shouldPlay && !this.audio.paused) {
                this.audio.pause();
                this.updatePlayButton(false);
            }
        }
        
        setTimeout(() => {
            this.isSyncing = false;
        }, 100);
    }

    // Gentle sync for continuous monitoring (smaller corrections)
    performGentleSync(targetPosition, shouldPlay) {
        if (this.isSyncing) return;
        
        const currentPos = this.audio.currentTime;
        const timeDiff = Math.abs(currentPos - targetPosition);
        
        // Only make small adjustments for gentle sync
        if (timeDiff > 0.1 && timeDiff < 1.0) {
            // Gradual correction using playback rate adjustment
            if (currentPos < targetPosition) {
                this.audio.playbackRate = 1.05; // Speed up slightly
            } else {
                this.audio.playbackRate = 0.95; // Slow down slightly
            }
            
            // Reset to normal speed after correction
            setTimeout(() => {
                this.audio.playbackRate = 1.0;
            }, 1000);
        } else if (timeDiff >= 1.0) {
            // Large difference, do immediate sync
            this.performTimestampedSync(targetPosition, shouldPlay, Date.now());
        }
    }

    // Track sync statistics for monitoring
    updateSyncStats(drift) {
        this.syncStats.totalSyncs++;
        this.syncStats.avgDrift = ((this.syncStats.avgDrift * (this.syncStats.totalSyncs - 1)) + drift) / this.syncStats.totalSyncs;
        this.syncStats.maxDrift = Math.max(this.syncStats.maxDrift, drift);
        
        // Log stats every 10 syncs
        if (this.syncStats.totalSyncs % 10 === 0) {
            console.log(`Sync Stats - Total: ${this.syncStats.totalSyncs}, Avg Drift: ${this.syncStats.avgDrift.toFixed(3)}s, Max Drift: ${this.syncStats.maxDrift.toFixed(3)}s`);
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
        
        // Cleanup intervals
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
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

        this.audio.playbackRate = 1.0;
        this.audio.play().then(() => {
            this.updatePlayButton(true);
            // Send play command with precise timestamp
            this.socket.emit('play_pause', {
                room_id: this.currentRoom,
                is_playing: true,
                position: this.audio.currentTime,
                timestamp: Date.now()
            });
        }).catch(console.error);
    }

    pause() {
        if (!this.isHost) return;

        this.audio.pause();
        this.updatePlayButton(false);

        this.socket.emit('play_pause', {
            room_id: this.currentRoom,
            is_playing: false,
            position: this.audio.currentTime,
            timestamp: Date.now()
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