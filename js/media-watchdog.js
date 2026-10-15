// Shared by the offline carousel (inlined into its generated page) and the playlist engine.
// Rotation must never wait on a media event alone: a starved decoder emits neither 'ended'
// nor 'error', and one that keeps its clock running can still show the same frame forever.
(function (root) {
    const TICK_MS = 1000;
    const STALL_GRACE_MS = 10000;
    const FIRST_FRAME_GRACE_MS = 8000;
    const FROZEN_GRACE_MS = 5000;

    // Calls onStuck(reason) once when the video stops moving; returns a stop function.
    function watchVideo(video, onStuck) {
        let done = false;
        let lastTime = -1;
        let clockIdle = 0;
        let frames = 0;
        let lastFrames = -1;
        let frameIdle = 0;

        const finish = (reason) => {
            if (done) return;
            done = true;
            clearInterval(timer);
            onStuck(reason);
        };

        if (video.requestVideoFrameCallback) {
            const onFrame = function () {
                if (done) return;
                frames++;
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
        }

        const timer = setInterval(function () {
            if (done) return;

            if (video.currentTime !== lastTime) {
                lastTime = video.currentTime;
                clockIdle = 0;
            } else {
                clockIdle += TICK_MS;
                if (clockIdle >= STALL_GRACE_MS) {
                    finish('never advanced past ' + Math.round(video.currentTime) + 's');
                    return;
                }
            }

            if (!video.requestVideoFrameCallback) return;
            if (frames !== lastFrames) {
                lastFrames = frames;
                frameIdle = 0;
                return;
            }
            // Frames already seen prove the decoder works, so a shorter grace is safe; before
            // the first one the wait has to cover a slow start.
            frameIdle += TICK_MS;
            if (frameIdle >= (frames > 0 ? FROZEN_GRACE_MS : FIRST_FRAME_GRACE_MS)) {
                finish('picture frozen at ' + Math.round(video.currentTime) + 's');
            }
        }, TICK_MS);

        return function stop() {
            done = true;
            clearInterval(timer);
        };
    }

    // Hands the decoder back: sibling screens share one hardware decode engine.
    function releaseVideo(video) {
        if (!video || !video.getAttribute('src')) return;
        video.pause();
        video.removeAttribute('src');
        video.load();
    }

    root.MediaWatchdog = { watchVideo, releaseVideo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
