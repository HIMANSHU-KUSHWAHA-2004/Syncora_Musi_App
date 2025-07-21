class SyncMusicPlayer {
    constructor() {
        this.socket = io();
        this.currentRoom = null;
        this.isHost = false;
        this.audio = document.getElementById('audio-player');
        this.audio.playbackRate = 1.0;
        this.syncThreshold = 0.1; // Increased threshold for stability
        
        // Synchronization state
        this.lastSyncTime = 0;
        this.syncInterval = null;
        this.pendingSeek = false;
        this.serverTimeOffset = 0;
        this.isAudioReady = false;
        
        // Improved sync tracking
        this.lastHostState = null;
        this.syncDebounceTimeout = null;
        this.rateAdjustmentTimeout = null;
        
        // Buffer management
        this.syncBuffer = [];
        this.maxSyncBuffer = 5;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupSocketEvents();
        this.calculateServerTimeOffset();
    }

    // Enhanced server time offset calculation
    async calculateServerTimeOffset() {
        try {
            const measurements = [];
            
            // Take 10 measurements for better accuracy
            for (let i = 0; i < 10; i++) {
                const start = performance.now();
                
                // Use ping endpoint for faster response
                const response = await fetch('/api/ping', { 
                    method: 'GET',
                    cache: 'no-cache'
                });
                
                const end = performance.now();
                const data = await response.json();
                
                const rtt = end - start;
                const networkDelay = rtt / 2;
                const offset = data.server_time - (start + networkDelay);
                
                measurements.push({ 
                    offset, 
                    rtt,
                    timestamp: start 
                });
                
                if (i < 9) await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // Filter out high-latency measurements (> 50ms RTT)
            const validMeasurements = measurements
                .filter(m => m.rtt < 50)
                .map(m => m.offset);
            
            if (validMeasurements.length >= 3) {
                // Use median of valid measurements
                validMeasurements.sort((a, b) => a - b);
                const mid = Math.floor(validMeasurements.length / 2);
                this.serverTimeOffset = validMeasurements.length % 2 
                    ? validMeasurements[mid]
                    : (validMeasurements[mid - 1] + validMeasurements[mid]) / 2;
            } else {
                // Fallback to average of all measurements
                this.serverTimeOffset = measurements.reduce((sum, m) => sum + m.offset, 0) / measurements.length;
            }
            
            console.log(`🕐 Server time offset: ${this.serverTimeOffset.toFixed(2)}ms (${validMeasurements.length}/${measurements.length} valid measurements)`);
            
        } catch (error) {
            console.warn('⚠️ Could not calculate server time offset:', error);
            this.serverTimeOffset = 0;
        }
    }

    getServerTime() {
        return performance.now() + this.serverTimeOffset;
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
            this.isAudioReady = true;
            this.updateTimeDisplay();
            this.audio.playbackRate = 1.0;
            console.log('🎵 Audio metadata loaded, duration:', this.audio.duration?.toFixed(2), 's');
        });

        this.audio.addEventListener('canplaythrough', () => {
            this.isAudioReady = true;
            console.log('🎵 Audio ready for playback');
        });

        this.audio.addEventListener('timeupdate', () => {
            this.updateTimeDisplay();
            
            // Continuous micro-sync for clients
            if (!this.isHost && this.lastHostState && this.isAudioReady) {
                this.performMicroSync();
            }
        });

        this.audio.addEventListener('seeked', () => {
            if (this.isHost && !this.pendingSeek) {
                this.broadcastSeek();
            }
            this.pendingSeek = false;
        });

        this.audio.addEventListener('waiting', () => {
            console.log('⏳ Audio buffering...');
        });

        this.audio.addEventListener('error', (e) => {
            console.error('❌ Audio error:', e);
            this.isAudioReady = false;
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
            console.log('🏠 Room created:', this.currentRoom);
        });

        this.socket.on('room_joined', (data) => {
            this.currentRoom = data.room_id;
            this.isHost = data.is_host;
            this.showPlayer();
            console.log('🚪 Room joined:', this.currentRoom, 'as', this.isHost ? 'host' : 'client');

            if (data.current_song) {
                this.loadSong(data.current_song).then(() => {
                    // Wait for audio to be fully ready before syncing
                    this.waitForAudioReady().then(() => {
                        this.syncToState(data);
                    });
                }).catch(error => {
                    console.error('❌ Error loading song:', error);
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
            console.log('🎵 Song changed:', data.song);
            this.loadSong(data.song).then(() => {
                this.waitForAudioReady().then(() => {
                    this.syncToState(data);
                });
            }).catch(error => {
                console.error('❌ Error loading new song:', error);
            });
        });

        this.socket.on('sync_playback', (data) => {
            if (this.isHost) return;
            
            // Add to sync buffer for smoother processing
            this.addToSyncBuffer(data);
        });

        this.socket.on('sync_seek', (data) => {
            if (!this.isAudioReady || !this.audio.duration) {
                console.warn('⚠️ Audio not ready for seek');
                return;
            }

            if (data.position >= 0 && data.position <= this.audio.duration) {
                this.pendingSeek = true;
                this.audio.currentTime = data.position;
                console.log('⏭️ Synced seek to:', data.position.toFixed(2), 's');
            } else {
                console.warn('⚠️ Invalid seek position:', data.position, '(duration:', this.audio.duration, ')');
            }
        });

        this.socket.on('clients_updated', (data) => {
            document.getElementById('clients-count').textContent = `${data.clients} connected`;
        });

        this.socket.on('new_host', (data) => {
            const wasHost = this.isHost;
            this.isHost = data.is_host;
            this.updateHostControls();
            
            console.log('👑 Host changed:', this.isHost ? 'You are now host' : 'Host changed to another client');
            
            if (this.isHost && !wasHost) {
                this.startSyncLoop();
            } else if (!this.isHost && wasHost) {
                this.stopSyncLoop();
            }
        });

        this.socket.on('disconnect', () => {
            console.log('🔌 Disconnected from server');
            this.stopSyncLoop();
        });

        this.socket.on('reconnect', () => {
            console.log('🔄 Reconnected to server');
            if (this.currentRoom) {
                this.socket.emit('rejoin_room', { room_id: this.currentRoom });
            }
        });
    }

    // Wait for audio to be ready with timeout
    waitForAudioReady(timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (this.isAudioReady && this.audio.duration) {
                resolve();
                return;
            }

            const startTime = Date.now();
            const checkReady = () => {
                if (this.isAudioReady && this.audio.duration) {
                    resolve();
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('Audio ready timeout'));
                } else {
                    setTimeout(checkReady, 50);
                }
            };

            checkReady();
        });
    }

    // Add sync data to buffer for processing
    addToSyncBuffer(data) {
        this.syncBuffer.push({
            ...data,
            receivedAt: this.getServerTime()
        });

        // Keep buffer size manageable
        if (this.syncBuffer.length > this.maxSyncBuffer) {
            this.syncBuffer.shift();
        }

        // Process latest sync data
        this.processSyncBuffer();
    }

    // Process buffered sync data
    processSyncBuffer() {
        if (this.syncBuffer.length === 0 || !this.isAudioReady) return;

        // Use most recent sync data
        const latestSync = this.syncBuffer[this.syncBuffer.length - 1];
        this.syncToState(latestSync);
    }

    // Enhanced sync to state
    syncToState(data) {
        if (!this.isAudioReady || !this.audio.duration) {
            console.warn('⚠️ Audio not ready for sync');
            return;
        }

        // Store host state for micro-sync
        this.lastHostState = {
            position: data.position,
            isPlaying: data.is_playing,
            timestamp: data.timestamp || this.getServerTime(),
            serverTime: this.getServerTime()
        };

        let targetPosition = data.position;

        // Calculate expected position based on time elapsed
        if (data.timestamp && data.is_playing) {
            const timeSinceSync = (this.getServerTime() - data.timestamp) / 1000;
            targetPosition += Math.max(0, timeSinceSync - 0.03); // Account for 30ms processing delay
        }

        // Clamp to valid range
        targetPosition = Math.max(0, Math.min(targetPosition, this.audio.duration - 0.1));

        const currentTime = this.audio.currentTime;
        const timeDiff = Math.abs(currentTime - targetPosition);

        // Enhanced sync logic
        if (timeDiff > this.syncThreshold) {
            console.log(`🔄 Sync needed: ${currentTime.toFixed(2)}s → ${targetPosition.toFixed(2)}s (diff: ${timeDiff.toFixed(3)}s)`);
            
            if (timeDiff > 1.0) {
                // Large difference - immediate hard sync
                this.hardSync(targetPosition);
            } else if (timeDiff > 0.3) {
                // Medium difference - quick rate adjustment
                this.quickRateSync(targetPosition);
            } else {
                // Small difference - gradual rate adjustment
                this.gradualRateSync(targetPosition);
            }
        }

        // Sync play state
        this.syncPlayState(data.is_playing);
    }

    // Hard sync with immediate seek
    hardSync(targetPosition) {
        this.pendingSeek = true;
        this.audio.currentTime = targetPosition;
        console.log('⚡ Hard sync to:', targetPosition.toFixed(2), 's');
    }

    // Quick rate-based sync
    quickRateSync(targetPosition) {
        const diff = targetPosition - this.audio.currentTime;
        const rate = diff > 0 ? 1.15 : 0.85;
        
        this.setPlaybackRate(rate, 500);
        console.log('🏃 Quick rate sync:', rate, 'for', diff.toFixed(3), 's diff');
    }

    // Gradual rate-based sync
    gradualRateSync(targetPosition) {
        const diff = targetPosition - this.audio.currentTime;
        const rate = diff > 0 ? 1.05 : 0.95;
        
        this.setPlaybackRate(rate, 1000);
        console.log('🚶 Gradual rate sync:', rate, 'for', diff.toFixed(3), 's diff');
    }

    // Micro-sync for continuous adjustment
    performMicroSync() {
        if (!this.lastHostState || this.audio.paused) return;

        const expectedPosition = this.calculateExpectedPosition();
        const drift = expectedPosition - this.audio.currentTime;
        const absDrift = Math.abs(drift);

        // Only adjust for small drifts to avoid jarring changes
        if (absDrift > 0.02 && absDrift < 0.2) {
            const rate = drift > 0 ? 1.02 : 0.98;
            this.setPlaybackRate(rate, 200);
        }
    }

    // Calculate expected position based on last host state
    calculateExpectedPosition() {
        if (!this.lastHostState) return this.audio.currentTime;

        const elapsed = (this.getServerTime() - this.lastHostState.timestamp) / 1000;
        const expected = this.lastHostState.position + elapsed;
        
        return Math.min(expected, this.audio.duration - 0.1);
    }

    // Set playback rate with automatic reset
    setPlaybackRate(rate, duration) {
        if (this.rateAdjustmentTimeout) {
            clearTimeout(this.rateAdjustmentTimeout);
        }

        this.audio.playbackRate = rate;
        
        this.rateAdjustmentTimeout = setTimeout(() => {
            this.audio.playbackRate = 1.0;
            this.rateAdjustmentTimeout = null;
        }, duration);
    }

    // Sync play state
    syncPlayState(shouldPlay) {
        if (shouldPlay && this.audio.paused) {
            this.audio.play().catch(e => {
                console.error('❌ Play failed:', e);
            });
            this.updatePlayButton(true);
        } else if (!shouldPlay && !this.audio.paused) {
            this.audio.pause();
            this.updatePlayButton(false);
        }
    }

    // Enhanced sync loop for host
    startSyncLoop() {
        if (!this.isHost) return;
        
        this.stopSyncLoop();
        console.log('🔄 Starting sync loop');
        
        this.syncInterval = setInterval(() => {
            if (this.currentRoom && this.audio.src && this.isAudioReady) {
                this.broadcastSync();
            }
        }, 250); // More frequent sync (4x per second)
    }

    stopSyncLoop() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            console.log('⏹️ Sync loop stopped');
        }
    }

    // Enhanced broadcast sync
    broadcastSync() {
        if (!this.isHost || !this.isAudioReady || isNaN(this.audio.duration)) return;

        let position = this.audio.currentTime;
        
        // Validate and clamp position
        if (position > this.audio.duration) {
            position = this.audio.duration - 0.1;
            this.audio.currentTime = position;
        }

        const syncData = {
            room_id: this.currentRoom,
            position: position,
            is_playing: !this.audio.paused,
            timestamp: this.getServerTime(),
            duration: this.audio.duration,
            sync_id: Date.now() // Add unique ID for tracking
        };

        this.socket.emit('sync_playback', syncData);
    }

    broadcastSeek() {
        if (!this.isHost) return;

        const seekData = {
            room_id: this.currentRoom,
            position: this.audio.currentTime,
            timestamp: this.getServerTime()
        };

        this.socket.emit('seek', seekData);
        console.log('⏭️ Broadcast seek:', seekData.position.toFixed(2), 's');
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
        this.isAudioReady = false;
        this.lastHostState = null;
        this.syncBuffer = [];

        if (this.rateAdjustmentTimeout) {
            clearTimeout(this.rateAdjustmentTimeout);
            this.rateAdjustmentTimeout = null;
        }

        if (this.isHost && this.currentRoom) {
            fetch('/end_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: this.currentRoom })
            })
                .then(res => res.json())
                .then(data => console.log('✅ Cleanup result:', data))
                .catch(err => console.error('❌ Cleanup error:', err));
        }

        this.currentRoom = null;
        this.isHost = false;
        this.audio.pause();
        this.audio.src = '';
        this.audio.playbackRate = 1.0;
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
            console.log('▶️ Playing');
        }).catch(e => {
            console.error('❌ Play failed:', e);
            this.showError('Unable to play audio. Please check your connection.');
        });
    }

    pause() {
        if (!this.isHost) return;

        this.audio.pause();
        this.updatePlayButton(false);
        this.broadcastSync();
        console.log('⏸️ Paused');
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
        this.isAudioReady = false;
        
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.audio.removeEventListener('loadeddata', onLoad);
                this.audio.removeEventListener('error', onError);
                this.audio.removeEventListener('canplaythrough', onCanPlay);
            };
            
            const onLoad = () => {
                console.log('📁 Song data loaded:', filename);
            };
            
            const onCanPlay = () => {
                this.isAudioReady = true;
                document.getElementById('song-name').textContent = filename.replace(/^\d+_/, '');
                cleanup();
                resolve();
                console.log('✅ Song ready:', filename);
            };
            
            const onError = (e) => {
                cleanup();
                reject(e);
            };

            this.audio.addEventListener('loadeddata', onLoad);
            this.audio.addEventListener('canplaythrough', onCanPlay);
            this.audio.addEventListener('error', onError);
            
            this.audio.src = `/static/uploads/${filename}`;
            this.audio.playbackRate = 1.0;
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