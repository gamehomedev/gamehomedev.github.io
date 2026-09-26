(() => {
    'use strict';

    const DIAGNOSTICS_NAMESPACE =
        'urn:x-cast:com.gamehomedev.webcastmote.diagnostics';
    const HLS_CONTENT_TYPE = 'application/x-mpegurl';

    const context = cast.framework.CastReceiverContext.getInstance();
    const playerManager = context.getPlayerManager();

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

            broadcastDiagnostic('LOAD_RECEIVED', {
                url,
                contentType: media.contentType || null,
                streamType: media.streamType || null,
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
    playbackConfig.shakaConfig = {
        manifest: {
            retryParameters: {
                maxAttempts: 4,
                baseDelay: 500,
                backoffFactor: 2,
                fuzzFactor: 0.5,
                timeout: 15000,
            },
        },
        streaming: {
            bufferingGoal: 20,
            rebufferingGoal: 2,
            retryParameters: {
                maxAttempts: 4,
                baseDelay: 500,
                backoffFactor: 2,
                fuzzFactor: 0.5,
                timeout: 15000,
            },
        },
    };

    const options = new cast.framework.CastReceiverOptions();
    options.statusText = 'Ready to cast';
    options.useShakaForHls = true;
    options.playbackConfig = playbackConfig;
    options.customNamespaces = {
        [DIAGNOSTICS_NAMESPACE]: cast.framework.system.MessageType.JSON,
    };
    options.versionCode = 1;

    context.start(options);
})();
