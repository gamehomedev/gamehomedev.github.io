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

            const details = media.customData || {};
            const width = Number(details.width) || undefined;
            const height = Number(details.height) || undefined;
            const frameRate = Number(details.frameRate) || undefined;
            const codecs = details.codecs || undefined;
            const capabilityType =
                details.container === 'HLS_MPEG2_TS' ? 'video/mp2t' : media.contentType;
            const canDisplay = codecs
                ? context.canDisplayType(
                    capabilityType,
                    codecs,
                    width,
                    height,
                    frameRate,
                )
                : true;

            broadcastDiagnostic('CAPABILITY_CHECK', {
                supported: canDisplay,
                contentType: capabilityType || null,
                codecs: codecs || null,
                width: width || null,
                height: height || null,
                frameRate: frameRate || null,
            });

            // A 1936-pixel H.264 stream is wider than the 1920-pixel decoder
            // limit of legacy Chromecast devices. Without this check those
            // devices report PLAYING and output AAC audio over a black screen.
            if (!canDisplay && width && width > 1920) {
                const error = new cast.framework.messages.ErrorData(
                    cast.framework.messages.ErrorType.LOAD_FAILED,
                );
                error.reason = cast.framework.messages.ErrorReason.NOT_SUPPORTED;
                error.customData = {
                    reason: 'VIDEO_FORMAT_NOT_SUPPORTED',
                    codecs,
                    width,
                    height,
                    frameRate,
                };
                broadcastDiagnostic('PLAYBACK_REJECTED', error.customData);
                return error;
            }

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
    // Older Chromecast models can play MPEG-TS HLS through CAF's native player
    // even when Shaka/MSE rejects the same stream with CONTENT_UNSUPPORTED_BY_BROWSER (4032).
    options.useShakaForHls = false;
    options.playbackConfig = playbackConfig;
    options.customNamespaces = {
        [DIAGNOSTICS_NAMESPACE]: cast.framework.system.MessageType.JSON,
    };
    options.versionCode = 3;

    context.start(options);
})();
