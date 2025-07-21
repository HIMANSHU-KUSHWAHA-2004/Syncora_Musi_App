class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.syncThreshold = 0.15; // Reduced to 150ms for tighter sync
        this.serverTimeOffset = 0;
        this.latency = 0;
        this.syncInterval = null;
        this.lastSyncTime = 0;
        this.playStartTime = null;
        this.targetPosition = 0;
        this.isSyncing = false;
        this.syncQueue = []; // Queue for handling rapid sync events
        this.latencyHistory = []; // Track latency history for smoothing
        this.maxLatencyHistory = 10;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.measureLatencyPeriodically();
        this.syncTimeWithServer();
    }

    // Enhanced latency measurement with history tracking
    measureLatencyPeriodically() {
        setInterval(() => {
            this.measureLatency();
        }, 3000); // Every 3 seconds
    }

    measureLatency() {
        const start = performance.now();
        this.socket.emit('ping_sync');
        
        this.socket.once('pong_sync', (data) => {
            const end = performance.now();
            const currentLatency = (end - start) / 2;
            
            // Add to history and calculate smoothed latency
            this.latencyHistory.push(currentLatency);
            if (this.latencyHistory.length > this.maxLatencyHistory) {
                this.latencyHistory.shift();
            }
            
            // Use median of recent latency measurements for stability
            const sortedLatency = [...this.latencyHistory].sort((a, b) => a - b);
            this.latency = sortedLatency[Math.floor(sortedLatency.length / 2)];
            
            // Update server time offset with better precision
            const serverTime = data.server_time;
            const clientTime = performance.now() + performance.timeOrigin;
            this.serverTimeOffset = serverTime - clientTime;
            
            // Send smoothed latency to server
            if (this.currentRoom) {
                this.socket.emit('update_latency', {
                    room_id: this.currentRoom,
                    latency: this.latency
                });
            }
        });
    }

    // More precise server time calculation
    getServerTime() {
        return (performance.now() + performance.timeOrigin) + this.serverTimeOffset;
    }

    // Enhanced sync time with server
    syncTimeWithServer() {
        const start = performance.now();
        fetch('/sync_time')
            .then(res => res.json())
            .then(data => {
                const end = performance.now();
                const roundTripTime = end - start;
                const networkDelay = roundTripTime / 2;
                
                const clientTime = performance.now() + performance.timeOrigin;
                this.serverTimeOffset = data.server_time - clientTime - networkDelay;
                
                console.log(`Time sync: offset=${this.serverTimeOffset.toFixed(2)}ms, RTT=${roundTripTime.toFixed(2)}ms`);
            })
            .catch(err => console.warn('Failed to sync time with server:', err));
    }

    // Calculate precise position with better algorithm
    calculatePrecisePosition(basePosition, isPlaying, playStartTime, receivedAt = null) {
        if (!isPlaying || !playStartTime) {
            return basePosition;
        }
        
        const referenceTime = receivedAt || this.getServerTime();
        const elapsed = Math.max(0, (referenceTime - playStartTime) / 1000.0);
        return Math.max(0, basePosition + elapsed);
    }

    // Enhanced sync function with queue processing and drift correction
    syncToPosition(targetData, forceSync = false) {
        // Add to sync queue to prevent overwhelming
        this.syncQueue.push({ targetData, forceSync, timestamp: performance.now() });
        
        // Process queue if not already processing
        if (!this.isSyncing) {
            this.processSyncQueue();
        }
    }

    processSyncQueue() {
        if (this.syncQueue.length === 0) return;
        
        // Get the most recent sync command
        const { targetData, forceSync } = this.syncQueue.pop();
        this.syncQueue = []; // Clear queue, only use latest
        
        this.isSyncing = true;
        
        const { position, is_playing, timestamp, play_start_time, server_position, sync_type } = targetData;
        const currentServerTime = this.getServerTime();
        
        // Calculate target position with network compensation
        let targetPosition = position;
        if (server_position !== undefined) {
            // Use server-calculated position if available
            targetPosition = server_position;
        } else if (is_playing && play_start_time) {
            const elapsed = (currentServerTime - play_start_time) / 1000.0;
            targetPosition = Math.max(0, position + elapsed);
        }
        
        // Apply latency compensation for playing audio
        if (is_playing) {
            const latencyCompensation = this.latency / 1000.0;
            targetPosition += latencyCompensation;
        }
        
        // Check if sync is needed
        const currentPosition = this.audio.currentTime;
        const timeDiff = Math.abs(currentPosition - targetPosition);
        const needsSync = forceSync || timeDiff > this.syncThreshold;
        
        if (needsSync && !this.audio.seeking) {
            console.log(`${sync_type || 'sync'}: current=${currentPosition.toFixed(3)}s, target=${targetPosition.toFixed(3)}s, diff=${timeDiff.toFixed(3)}s, latency=${this.latency.toFixed(1)}ms`);
            
            // Use smooth seeking for small differences, hard seeking for large ones
            if (timeDiff < 0.5 && sync_type !== 'seek') {
                this.smoothSeek(targetPosition);
            } else {
                this.audio.currentTime = Math.max(0, targetPosition);
            }
        }
        
        // Handle play/pause state synchronization
        this.synchronizePlayState(is_playing);
        
        // Update tracking variables
        this.playStartTime = play_start_time;
        this.lastSyncTime = currentServerTime;
        
        // Release sync lock after a short delay
        setTimeout(() => {
            this.isSyncing = false;
            // Process any queued syncs
            if (this.syncQueue.length > 0) {
                setTimeout(() => this.processSyncQueue(), 10);
            }
        }, 50);
    }

    // Smooth seeking for minor adjustments
    smoothSeek(targetPosition) {
        const currentPosition = this.audio.currentTime;
        const diff = targetPosition - currentPosition;
        
        if (Math.abs(diff) < 0.05) return; // Too small to matter
        
        // Adjust playback rate temporarily for smooth correction
        if (diff > 0) {
            // Need to speed up
            this.audio.playbackRate = 1.05;
        } else {
            // Need to slow down  
            this.audio.playbackRate = 0.95;
        }
        
        // Reset to normal speed after correction
        setTimeout(() => {
            if (this.audio) {
                this.audio.playbackRate = 1.0;
            }
        }, Math.min(1000, Math.abs(diff) * 2000));
    }

    // Separate play state synchronization
    synchronizePlayState(shouldPlay) {
        if (shouldPlay && this.audio.paused) {
            this.audio.play().catch(e => {
                console.warn('Play failed:', e);
                // Retry play after a short delay
                setTimeout(() => {
                    this.audio.play().catch(() => {});
                }, 100);
            });
            this.updatePlayButton(true);
        } else if (!shouldPlay && !this.audio.paused) {
            this.audio.pause();
            this.updatePlayButton(false);
        }
    }

    // Enhanced periodic sync with drift detection
    startPeriodicSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        this.syncInterval = setInterval(() => {
            if (this.currentRoom && !this.isHost && !this.isSyncing) {
                // Send sync check with current position
                const currentPosition = this.audio.currentTime;
                const currentTime = this.getServerTime();
                
                this.socket.emit('sync_check', {
                    room_id: this.currentRoom,
                    client_position: currentPosition,
                    client_time: currentTime
                });
                
                // Also request sync if it's been too long
                const timeSinceLastSync = currentTime - this.lastSyncTime;
                if (timeSinceLastSync > 3000) { // 3 seconds
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

        // Enhanced audio event handling
        this.audio.addEventListener('loadedmetadata', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && !this.isSyncing) {
                // Add small delay to ensure seeking is complete
                setTimeout(() => {
                    this.socket.emit('seek', {
                        room_id: this.currentRoom,
                        position: this.audio.currentTime
                    });
                }, 50);
            }
        });

        // Prevent seeking for non-hosts
        this.audio.addEventListener('seeking', (e) => {
            if (!this.isHost && !this.isSyncing) {
                e.preventDefault();
                this.audio.currentTime = this.audio.currentTime; // Reset position
                return false;
            }
        });

        // Handle audio loading states
        this.audio.addEventListener('canplay', () => {
            console.log('Audio ready to play');
        });

        this.audio.addEventListener('waiting', () => {
            console.log('Audio buffering...');
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
                setTimeout(() => {
                    this.syncToPosition({
                        position: data.position,
                        is_playing: data.is_playing,
                        timestamp: data.server_time,
                        play_start_time: data.last_update,
                        sync_type: 'initial'
                    }, true);
                }, 100); // Small delay to ensure audio is loaded
            }
            
            this.startPeriodicSync();
        });

        this.socket.on('join_error', (data) => {
            this.showError(data.message);
        });

        this.socket.on('song_changed', (data) => {
            this.loadSong(data.song);
            setTimeout(() => {
                this.syncToPosition({
                    position: data.position,
                    is_playing: data.is_playing,
                    timestamp: data.timestamp,
                    play_start_time: null,
                    sync_type: 'song_change'
                }, true);
            }, 200); // Wait for song to load
        });

        // Enhanced sync event handlers
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

        // New heartbeat sync handler
        this.socket.on('heartbeat_sync', (data) => {
            if (!this.isHost && !this.isSyncing) {
                this.syncToPosition(data);
            }
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent =
                `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            this.isHost = data.is_host;
            this.updateHostControls();
        });

        // Enhanced connection handling
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
                }, 200);
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

        // Clear sync queue
        this.syncQueue = [];

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
        this.latencyHistory = [];
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
        this.audio.load(); // Force reload
        document.getElementById('song-name').textContent = filename.replace(/^\d+_/, '');
    }

    updateTimeDisplay() {
        const current = this.formatTime(this.audio.currentTime);
        const duration = this.formatTime(this.audio.duration);
        document.getElementById('time-display').textContent = `${current} / ${duration}`;
        
        // Enhanced sync status display (remove in production)
        if (!this.isHost) {
            const syncStatus = document.getElementById('sync-status') || this.createSyncStatusElement();
            const avgLatency = this.latencyHistory.length > 0 ? 
                (this.latencyHistory.reduce((a, b) => a + b) / this.latencyHistory.length).toFixed(0) : 0;
            syncStatus.textContent = `Lat: ${avgLatency}ms | Off: ${this.serverTimeOffset.toFixed(0)}ms | Q: ${this.syncQueue.length}`;
        }
    }

    createSyncStatusElement() {
        const statusElement = document.createElement('div');
        statusElement.id = 'sync-status';
        statusElement.style.cssText = 'position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: white; padding: 5px 8px; border-radius: 4px; font-size: 11px; font-family: monospace;';
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