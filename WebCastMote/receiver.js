(() => {
    'use strict';

    const RECEIVER_VERSION_CODE = 20;
    const RECEIVER_VERSION_NAME = `v${RECEIVER_VERSION_CODE}`;
    const DIAGNOSTICS_NAMESPACE = 'urn:x-cast:com.gamehomedev.webcastmote.diagnostics';
    const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

    // Intercept cast.__platform__.canDisplayType and navigator.mediaCapabilities.decodingInfo
    // to prevent variant dropping for H.264/AAC/MPEG2-TS and non-standard or 4K/1080p+ resolutions (e.g. 1936x804, 3840x2160)
    const isAcceptableMedia = (typeStr) => {
        if (!typeStr) return true;
        const str = String(typeStr).toLowerCase();
        const isAvcOrMp4 = /avc1|h264|mp4v|mp4|mp2t|mpegurl/i.test(str);
        const isAacOrMp3 = /mp4a|aac|mp3|mpeg/i.test(str) || !/audio/i.test(str);
        const w = Number((str.match(/width=(\d+)/i) || [])[1]) || 0;
        const h = Number((str.match(/height=(\d+)/i) || [])[1]) || 0;
        const withinBudget = (w === 0 || h === 0) || (w <= 4096 && h <= 2304) || (w * h <= 9500000);
        return isAvcOrMp4 && isAacOrMp3 && withinBudget;
    };

    if (typeof window !== 'undefined' && window.cast && cast.__platform__ && typeof cast.__platform__.canDisplayType === 'function') {
        const origPlatformCanDisplay = cast.__platform__.canDisplayType.bind(cast.__platform__);
        cast.__platform__.canDisplayType = function (type) {
            try {
                const res = origPlatformCanDisplay(type);
                if (res instanceof Promise) {
                    return res.then((supported) => supported || isAcceptableMedia(type));
                }
                if (res) return true;
            } catch (_) {}
            return isAcceptableMedia(type);
        };
    }

    if (typeof navigator !== 'undefined' && navigator.mediaCapabilities && typeof navigator.mediaCapabilities.decodingInfo === 'function') {
        const origDecodingInfo = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
        navigator.mediaCapabilities.decodingInfo = async function (configuration) {
            try {
                const res = await origDecodingInfo(configuration);
                if (res && res.supported) return res;
            } catch (_) {}
            const videoType = (configuration?.video?.contentType || '').toLowerCase();
            const audioType = (configuration?.audio?.contentType || '').toLowerCase();
            const isAvc = /avc1|h264|mp4v|mp4|mp2t/i.test(videoType);
            const isAac = /mp4a|aac|mp3/i.test(audioType) || !audioType;
            const w = Number(configuration?.video?.width) || 0;
            const h = Number(configuration?.video?.height) || 0;
            const withinBudget = (w === 0 || h === 0) || (w <= 4096 && h <= 2304) || (w * h <= 9500000);
            if ((isAvc || !videoType) && isAac && withinBudget) {
                return {
                    supported: true,
                    smooth: true,
                    powerEfficient: true,
                    keySystemAccess: null,
                    configuration: configuration,
                };
            }
            return { supported: false, smooth: false, powerEfficient: false };
        };
    }

    // Patch Shaka Player prototype to ensure hardware resolution is not clamped below 4096x4096
    const patchShakaPlayer = (Player) => {
        if (!Player || Player._webCastMotePatched) return;
        Player._webCastMotePatched = true;

        const origSetMax = Player.prototype.setMaxHardwareResolution;
        if (origSetMax) {
            Player.prototype.setMaxHardwareResolution = function (w, h) {
                return origSetMax.call(this, Math.max(w || 0, 4096), Math.max(h || 0, 4096));
            };
        }

        const origInit = Player.prototype.init;
        if (origInit) {
            Player.prototype.init = function (...args) {
                try {
                    if (this.setMaxHardwareResolution) {
                        this.setMaxHardwareResolution(4096, 4096);
                    }
                } catch (_) {}
                return origInit.apply(this, args);
            };
        }

        const origConfigure = Player.prototype.configure;
        if (origConfigure) {
            Player.prototype.configure = function (config, ...args) {
                if (config && config.restrictions) {
                    config.restrictions.maxWidth = Math.max(config.restrictions.maxWidth || 0, 4096);
                    config.restrictions.maxHeight = Math.max(config.restrictions.maxHeight || 0, 4096);
                    config.restrictions.maxPixels = Math.max(config.restrictions.maxPixels || 0, 10000000);
                }
                const res = origConfigure.call(this, config, ...args);
                try {
                    if (this.setMaxHardwareResolution) {
                        this.setMaxHardwareResolution(4096, 4096);
                    }
                } catch (_) {}
                return res;
            };
        }
    };

    const setupShaka = (shakaObj) => {
        if (!shakaObj) return;
        if (shakaObj.Player) patchShakaPlayer(shakaObj.Player);
        if (shakaObj.net && shakaObj.net.NetworkingEngine && !shakaObj.net.NetworkingEngine._webCastMoteFiltered) {
            shakaObj.net.NetworkingEngine._webCastMoteFiltered = true;
            shakaObj.net.NetworkingEngine.registerResponseFilter((type, response) => {
                if (response && response.headers) {
                    const ct = (response.headers['content-type'] || response.headers['Content-Type'] || '').toLowerCase();
                    if (ct.startsWith('image/') || ct.startsWith('text/')) {
                        if (type === shakaObj.net.NetworkingEngine.RequestType.SEGMENT) {
                            response.headers['content-type'] = 'video/mp2t';
                        }
                    }
                }
            });
        }
    };

    if (typeof window !== 'undefined') {
        if (window.shaka) {
            setupShaka(window.shaka);
        } else {
            let shakaRef = window.shaka;
            Object.defineProperty(window, 'shaka', {
                configurable: true,
                enumerable: true,
                get() { return shakaRef; },
                set(val) {
                    shakaRef = val;
                    setupShaka(shakaRef);
                }
            });
        }
    }

    const ReceiverState = Object.freeze({
        SPLASH: 'splash',
        CONNECTING: 'connecting',
        WAITING: 'waiting',
        LOADING: 'loading',
        BUFFERING: 'buffering',
        PLAYING: 'playing',
        PAUSED: 'paused',
    });

    class ReceiverView {
        constructor(video) {
            this.video = video;
            this.root = document.getElementById('receiver-ui');
            document.querySelectorAll('.receiver-version-label').forEach((el) => {
                el.textContent = RECEIVER_VERSION_NAME;
            });
            this.statusKicker = document.getElementById('status-kicker');
            this.statusTitle = document.getElementById('status-title');
            this.statusDetail = document.getElementById('status-detail');
            this.footer = document.getElementById('receiver-footer');
            this.mediaPanel = document.getElementById('media-panel');
            this.mediaEyebrow = document.getElementById('media-eyebrow');
            this.mediaState = document.getElementById('media-state');
            this.mediaTitle = document.getElementById('media-title');
            this.timelineProgress = document.getElementById('timeline-progress');
            this.mediaPosition = document.getElementById('media-position');
            this.mediaDuration = document.getElementById('media-duration');
            this.message = document.getElementById('receiver-message');
            this.messageTitle = document.getElementById('receiver-message-title');
            this.messageDetail = document.getElementById('receiver-message-detail');
            this.title = 'Web video';
            this.state = ReceiverState.SPLASH;
            this.hasStartedPlayback = false;
            this.hideTimer = null;
        }

        setMedia(media) {
            this.hasStartedPlayback = false;
            this.title = media?.metadata?.title || media?.customData?.title || 'Web video';
            this.mediaTitle.textContent = this.title;
            this.mediaPanel.hidden = false;
        }

        render(state) {
            this.state = state;
            this.root.dataset.state = state;
            this.root.classList.remove('is-idle');
            if (state === ReceiverState.PLAYING) this.hasStartedPlayback = true;
            const isPlaybackOverlay = this.hasStartedPlayback && [
                ReceiverState.PLAYING,
                ReceiverState.PAUSED,
                ReceiverState.BUFFERING,
            ].includes(state);
            this.root.classList.toggle('playback-active', isPlaybackOverlay);
            this.hideMessage();
            clearTimeout(this.hideTimer);

            const copy = {
                [ReceiverState.SPLASH]: ['WELCOME', 'WebCastMote', 'A better way to enjoy media on your TV'],
                [ReceiverState.CONNECTING]: ['CONNECTING', 'Connecting to your phone', 'Keep WebCastMote open on the same Wi-Fi network'],
                [ReceiverState.WAITING]: ['READY TO CAST', 'Waiting for media', 'Choose a video in WebCastMote on your phone'],
                [ReceiverState.LOADING]: ['PREPARING', 'Opening your video', 'Checking the stream and preparing playback'],
                [ReceiverState.BUFFERING]: ['JUST A MOMENT', 'Buffering media', 'Playback will begin as soon as enough video is ready'],
            }[state];

            if (copy) {
                [this.statusKicker.textContent, this.statusTitle.textContent, this.statusDetail.textContent] = copy;
            }

            const hasMedia = [ReceiverState.LOADING, ReceiverState.BUFFERING, ReceiverState.PLAYING, ReceiverState.PAUSED].includes(state);
            this.mediaPanel.hidden = !hasMedia;
            this.footer.hidden = !hasMedia;
            this.footer.textContent = hasMedia ? 'Control playback from WebCastMote on your phone' : 'Choose a video in WebCastMote on your phone';

            if (state === ReceiverState.PLAYING) {
                this.mediaEyebrow.textContent = 'NOW PLAYING';
                this.mediaState.textContent = 'Playing';
                this.hideTimer = setTimeout(() => this.root.classList.add('is-idle'), 1800);
            } else if (state === ReceiverState.PAUSED) {
                this.mediaEyebrow.textContent = 'PLAYBACK PAUSED';
                this.mediaState.textContent = 'Paused';
            } else if (state === ReceiverState.BUFFERING) {
                this.mediaEyebrow.textContent = 'BUFFERING';
                this.mediaState.textContent = 'Waiting';
            } else if (state === ReceiverState.LOADING) {
                this.mediaEyebrow.textContent = 'PREPARING MEDIA';
                this.mediaState.textContent = 'Loading';
            }
            this.updateProgress();
        }

        revealPlaybackInfo() {
            if (this.state !== ReceiverState.PLAYING) return;
            this.root.classList.remove('is-idle');
            clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(() => this.root.classList.add('is-idle'), 1600);
        }

        resetMedia() {
            this.hasStartedPlayback = false;
            this.root.classList.remove('playback-active', 'is-idle');
            this.mediaPanel.hidden = true;
        }

        updateProgress() {
            const position = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
            const duration = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : null;
            const percentage = duration ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
            this.timelineProgress.style.width = `${percentage}%`;
            this.mediaPosition.textContent = this.formatTime(position);
            this.mediaDuration.textContent = duration ? this.formatTime(duration) : 'LIVE';
        }

        showError(title, detail) {
            clearTimeout(this.hideTimer);
            this.messageTitle.textContent = title;
            this.messageDetail.textContent = detail;
            this.message.hidden = false;
        }

        hideMessage() {
            this.message.hidden = true;
        }

        formatTime(seconds) {
            const value = Math.max(0, Math.floor(seconds || 0));
            const hours = Math.floor(value / 3600);
            const minutes = Math.floor((value % 3600) / 60);
            const remaining = value % 60;
            return hours > 0
                ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
                : `${minutes}:${String(remaining).padStart(2, '0')}`;
        }
    }

    const context = cast.framework.CastReceiverContext.getInstance();
    const playerManager = context.getPlayerManager();
    const video = document.getElementById('cast-video');
    const view = new ReceiverView(video);
    playerManager.setMediaElement(video);

    const broadcastDiagnostic = (type, details = {}) => {
        const payload = { type, timestamp: new Date().toISOString(), ...details };
        console.log('[WebCastMote]', payload);
        try {
            context.sendCustomMessage(DIAGNOSTICS_NAMESPACE, undefined, payload);
        } catch (error) {
            console.warn('[WebCastMote] Unable to send diagnostics', error);
        }
    };

    const mediaElementDetails = () => ({
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
    });

    const startupTimer = setTimeout(() => view.render(ReceiverState.CONNECTING), 320);
    context.addEventListener(cast.framework.system.EventType.READY, () => {
        clearTimeout(startupTimer);
        view.render(context.getSenders().length > 0 ? ReceiverState.WAITING : ReceiverState.CONNECTING);
    });
    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, () => {
        if (!video.currentSrc) view.render(ReceiverState.WAITING);
    });
    context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, () => {
        if (!video.currentSrc && context.getSenders().length === 0) view.render(ReceiverState.CONNECTING);
    });

    video.addEventListener('timeupdate', () => view.updateProgress());
    video.addEventListener('seeking', () => {
        view.revealPlaybackInfo();
        view.updateProgress();
    });
    ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error'].forEach((eventName) => {
        video.addEventListener(eventName, () => {
            broadcastDiagnostic(`MEDIA_ELEMENT_${eventName.toUpperCase()}`, mediaElementDetails());
        });
    });

    playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
        const media = request.media;
        if (!media) return request;

        const url = media.contentUrl || media.contentId || '';
        const declaredType = (media.contentType || '').toLowerCase();
        const looksLikeHls = declaredType.includes('mpegurl') || /(?:\.m3u8?(?:$|\?)|\/m3u8?\/|\/hls\/|\/list\/)/i.test(url);
        if (looksLikeHls) media.contentType = HLS_CONTENT_TYPE;

        const details = media.customData || {};
        const width = Number(details.width) || undefined;
        const height = Number(details.height) || undefined;
        const frameRate = Number(details.frameRate) || undefined;
        const codecs = details.codecs || undefined;
        const capabilityType = looksLikeHls && details.container === 'HLS_MPEG2_TS' ? 'video/mp4' : (media.contentType || 'video/mp4');
        const canDisplay = codecs ? context.canDisplayType(capabilityType, codecs, Math.min(width || 1920, 1920), Math.min(height || 1080, 1080), frameRate) : true;

        broadcastDiagnostic('CAPABILITY_CHECK', {
            supported: canDisplay,
            contentType: capabilityType || null,
            codecs: codecs || null,
            width: width || null,
            height: height || null,
            frameRate: frameRate || null,
            skipped: !codecs,
        });
        if (!canDisplay) broadcastDiagnostic('CAPABILITY_WARNING', { codecs: codecs || null, width: width || null, height: height || null });

        view.setMedia(media);
        view.render(ReceiverState.LOADING);
        broadcastDiagnostic('LOAD_RECEIVED', {
            url,
            contentType: media.contentType || null,
            streamType: media.streamType || null,
            playbackEngine: looksLikeHls ? 'shaka' : 'caf-default',
        });
        return request;
    });

    playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOADING, () => view.render(ReceiverState.LOADING));
    playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
        view.updateProgress();
        broadcastDiagnostic('PLAYER_LOAD_COMPLETE');
    });
    playerManager.addEventListener(cast.framework.events.EventType.PLAYING, () => view.render(ReceiverState.PLAYING));
    playerManager.addEventListener(cast.framework.events.EventType.PAUSE, () => view.render(ReceiverState.PAUSED));
    playerManager.addEventListener(cast.framework.events.EventType.BUFFERING, (event) => {
        view.render(event.isBuffering ? ReceiverState.BUFFERING : (video.paused ? ReceiverState.PAUSED : ReceiverState.PLAYING));
        broadcastDiagnostic('BUFFERING', { isBuffering: event.isBuffering });
    });
    playerManager.addEventListener(cast.framework.events.EventType.MEDIA_FINISHED, () => {
        view.resetMedia();
        view.render(ReceiverState.WAITING);
    });
    playerManager.addEventListener(cast.framework.events.EventType.ERROR, (event) => {
        view.showError('Playback could not continue', 'Try another media source or start playback again from your phone.');
        broadcastDiagnostic('PLAYBACK_ERROR', {
            detailedErrorCode: event.detailedErrorCode ?? null,
            reason: event.reason ?? null,
            severity: event.severity ?? null,
            triggeredByEventType: event.triggeredByEventType ?? null,
            error: event.error ? String(event.error) : null,
        });
    });
    playerManager.addEventListener(cast.framework.events.EventType.BITRATE_CHANGED, (event) => {
        broadcastDiagnostic('BITRATE_CHANGED', {
            totalBitrate: event.totalBitrate ?? null,
            audioBitrate: event.audioBitrate ?? null,
            videoBitrate: event.videoBitrate ?? null,
        });
    });

    const playbackConfig = new cast.framework.PlaybackConfig();
    playbackConfig.autoResumeNumberOfSegments = 1;
    playbackConfig.manifestRequestHandler = (requestInfo) => { requestInfo.withCredentials = false; return requestInfo; };
    playbackConfig.segmentRequestHandler = (requestInfo) => { requestInfo.withCredentials = false; return requestInfo; };
    playbackConfig.manifestHandler = (manifest) => {
        let text = manifest.replace(/^\uFEFF/, '').trimStart();
        // Normalize any non-standard width declarations near 1080p (e.g. 1936x804 -> 1920x804)
        // so hardware restriction checks in any player engine will never reject the variant.
        return text.replace(/RESOLUTION=(\d+)x(\d+)/gi, (match, wStr, hStr) => {
            let w = parseInt(wStr, 10);
            let h = parseInt(hStr, 10);
            if (w > 1920 && w <= 2048) {
                w = 1920;
            }
            return `RESOLUTION=${w}x${h}`;
        });
    };
    playbackConfig.shakaConfiguration = {
        streaming: {
            bufferingGoal: 30,
            rebufferingGoal: 2,
            bufferBehind: 30,
            ignoreTextStreamFailures: true,
            alwaysStreamText: false,
            smallGapLimit: 1.5,
            jumpLargeGaps: true,
            forceTransmux: true,
            forceTransmuxTS: true,
        },
        mediaSource: {
            forceTransmux: true,
        },
        manifest: {
            hls: {
                ignoreTextStreamFailures: true,
            },
        },
        restrictions: {
            minWidth: 0,
            maxWidth: 4096,
            minHeight: 0,
            maxHeight: 4096,
            minPixels: 0,
            maxPixels: 10000000,
        },
    };

    const options = new cast.framework.CastReceiverOptions();
    options.statusText = 'Ready to cast';
    options.useShakaForHls = true;
    options.playbackConfig = playbackConfig;
    options.customNamespaces = { [DIAGNOSTICS_NAMESPACE]: cast.framework.system.MessageType.JSON };
    options.versionCode = RECEIVER_VERSION_CODE;
    context.start(options);
})();
