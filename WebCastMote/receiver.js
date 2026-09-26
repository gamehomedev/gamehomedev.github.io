(() => {
    'use strict';

    const DIAGNOSTICS_NAMESPACE =
        'urn:x-cast:com.gamehomedev.webcastmote.diagnostics';
    const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

    const context = cast.framework.CastReceiverContext.getInstance();
    const playerManager = context.getPlayerManager();
    const video = document.getElementById('cast-video');
    playerManager.setMediaElement(video);

    const showReceiverMessage = (title, detail) => {
        document.getElementById('receiver-message-title').textContent = title;
        document.getElementById('receiver-message-detail').textContent = detail;
        document.getElementById('receiver-message').hidden = false;
    };

    const hideReceiverMessage = () => {
        document.getElementById('receiver-message').hidden = true;
    };

    const broadcastDiagnostic = (type, details = {}) => {
        const payload = {
            type,
            timestamp: new Date().toISOString(),
            ...details,
        };
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

    ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error']
        .forEach((eventName) => {
            video.addEventListener(eventName, () => {
                broadcastDiagnostic(`MEDIA_ELEMENT_${eventName.toUpperCase()}`, mediaElementDetails());
            });
        });

    playerManager.setMessageInterceptor(
        cast.framework.messages.MessageType.LOAD,
        (request) => {
            const media = request.media;
            if (!media) {
                return request;
            }

            const url = media.contentUrl || media.contentId || '';
            const declaredType = (media.contentType || '').toLowerCase();
            const looksLikeHls =
                declaredType.includes('mpegurl') ||
                /(?:\.m3u8?(?:$|\?)|\/m3u8?\/|\/hls\/|\/list\/)/i.test(url);

            if (looksLikeHls) {
                media.contentType = HLS_CONTENT_TYPE;
            }

            const details = media.customData || {};
            const width = Number(details.width) || undefined;
            const height = Number(details.height) || undefined;
            const frameRate = Number(details.frameRate) || undefined;
            const codecs = details.codecs || undefined;
            const isMpegTsHls =
                looksLikeHls && details.container === 'HLS_MPEG2_TS';

            let canDisplay = true;
            let capabilityType = isMpegTsHls ? 'video/mp2t' : media.contentType;
            if (codecs) {
                canDisplay = context.canDisplayType(
                    capabilityType,
                    codecs,
                    width,
                    height,
                    frameRate,
                );
            }

            broadcastDiagnostic('CAPABILITY_CHECK', {
                supported: canDisplay,
                contentType: capabilityType || null,
                codecs: codecs || null,
                width: width || null,
                height: height || null,
                frameRate: frameRate || null,
                skipped: !codecs,
            });

            // canDisplayType() is advisory. Some legacy Chromecast firmware
            // returns false for MPEG-TS streams that its native HLS pipeline
            // can still decode. Continue playback and report the mismatch.
            if (!canDisplay) {
                broadcastDiagnostic('CAPABILITY_WARNING', {
                    codecs: codecs || null,
                    width: width || null,
                    height: height || null,
                });
            }

            hideReceiverMessage();

            broadcastDiagnostic('LOAD_RECEIVED', {
                url,
                contentType: media.contentType || null,
                streamType: media.streamType || null,
                playbackEngine: looksLikeHls ? 'native-hls' : 'caf-default',
            });
            return request;
        },
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.ERROR,
        (event) => {
            broadcastDiagnostic('PLAYBACK_ERROR', {
                detailedErrorCode: event.detailedErrorCode ?? null,
                reason: event.reason ?? null,
                severity: event.severity ?? null,
                triggeredByEventType: event.triggeredByEventType ?? null,
                error: event.error ? String(event.error) : null,
            });
        },
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
        () => broadcastDiagnostic('PLAYER_LOAD_COMPLETE'),
    );

    // Fires when Shaka selects an audio or video bitrate variant.
    // A missing VIDEO entry here means Shaka found no playable video track.
    playerManager.addEventListener(
        cast.framework.events.EventType.BITRATE_CHANGED,
        (event) => {
            broadcastDiagnostic('BITRATE_CHANGED', {
                totalBitrate: event.totalBitrate ?? null,
                audioBitrate: event.audioBitrate ?? null,
                videoBitrate: event.videoBitrate ?? null,
            });
        },
    );

    // Fires when playback stalls waiting for data.
    playerManager.addEventListener(
        cast.framework.events.EventType.BUFFERING,
        (event) => {
            broadcastDiagnostic('BUFFERING', { isBuffering: event.isBuffering });
        },
    );

    // PLAYER_LOAD_BEGIN is not a real CAF EventType — removed.
    // shakaConfiguration below is the documented way to reach Shaka's config.


    const playbackConfig = new cast.framework.PlaybackConfig();
    playbackConfig.autoResumeNumberOfSegments = 1;
    playbackConfig.manifestRequestHandler = (requestInfo) => {
        requestInfo.withCredentials = false;
        return requestInfo;
    };
    playbackConfig.segmentRequestHandler = (requestInfo) => {
        requestInfo.withCredentials = false;
        return requestInfo;
    };
    playbackConfig.manifestHandler = (manifest) =>
        manifest.replace(/^\uFEFF/, '').trimStart();

    const options = new cast.framework.CastReceiverOptions();
    options.statusText = 'Ready to cast';
    // Native HLS is required on older Chromecast devices. Shaka/MSE rejects
    // otherwise valid MPEG-TS streams with error 4032 before playback starts.
    options.useShakaForHls = false;
    options.playbackConfig = playbackConfig;
    options.customNamespaces = {
        [DIAGNOSTICS_NAMESPACE]: cast.framework.system.MessageType.JSON,
    };
    options.versionCode = 11;

    context.start(options);
})();
