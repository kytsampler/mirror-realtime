"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWebcam } from "@/hooks/useWebcam";
import { useWebSocket } from "@/hooks/useWebSocket";

type Phase = "idle" | "live" | "playback";

const FAL_APP_ALIAS = process.env.NEXT_PUBLIC_FAL_APP_ALIAS || "krea-wan-14b";
const PROMPT =
  "Realtime reinterpretation of the connected webcam feed, high fidelity, cinematic lighting.";
const INPUT_FPS = 10;
const STREAM_STRENGTH = 0.5;
const NUM_BLOCKS = 1000;
const LIVE_DURATION_MS = 30_000;
const LOOP_DURATION_MS = 45_000;
const MAX_RECORDING_FPS = 12;
const MAX_RECORDED_FRAMES = Math.ceil(
  (LOOP_DURATION_MS / 1000) * MAX_RECORDING_FPS
);

export default function Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(480);
  const [isGenerating, setIsGenerating] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const recordedBlobsRef = useRef<Blob[]>([]);
  const playbackBitmapsRef = useRef<ImageBitmap[]>([]);
  const playbackIntervalRef = useRef<number | null>(null);
  const liveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isLiveDrawingRef = useRef(false);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef<number | null>(null);
  const liveStartTimeRef = useRef<number | null>(null);
  const liveEndTimeRef = useRef<number | null>(null);

  const { webcamVideoRef, startWebcam, stopWebcam } = useWebcam();

  const stopRecordedPlayback = useCallback(() => {
    if (playbackIntervalRef.current !== null) {
      window.clearInterval(playbackIntervalRef.current);
      playbackIntervalRef.current = null;
    }
    playbackBitmapsRef.current.forEach((bitmap) => {
      try {
        bitmap.close();
      } catch (error) {
        console.warn("Failed to release playback frame", error);
      }
    });
    playbackBitmapsRef.current = [];
  }, []);

  const startRecordedPlayback = useCallback(async () => {
    stopRecordedPlayback();

    const blobs = recordedBlobsRef.current;
    if (blobs.length === 0) {
      setPhase("idle");
      return;
    }

    setPhase("playback");

    try {
      const bitmaps = await Promise.all(
        blobs.map((blob) => createImageBitmap(blob))
      );

      playbackBitmapsRef.current = bitmaps;

      if (bitmaps.length === 0) {
        setPhase("idle");
        return;
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        setPhase("idle");
        return;
      }

      canvas.width = bitmaps[0].width;
      canvas.height = bitmaps[0].height;

      let frameIndex = 0;

      const drawFrame = () => {
        const frames = playbackBitmapsRef.current;
        if (frames.length === 0) {
          return;
        }

        const bitmap = frames[frameIndex];
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        frameIndex = (frameIndex + 1) % frames.length;
      };

      drawFrame();

      const interval = Math.max(
        LOOP_DURATION_MS / playbackBitmapsRef.current.length,
        16
      );

      playbackIntervalRef.current = window.setInterval(drawFrame, interval);
    } catch (error) {
      console.error("Failed to prepare playback", error);
      setPhase("idle");
    }
  }, [setPhase, stopRecordedPlayback]);

  const waitForVideoReady = useCallback(() => {
    const video = webcamVideoRef.current;
    if (!video) {
      return Promise.reject(new Error("Webcam not initialized"));
    }

    if (video.readyState >= video.HAVE_ENOUGH_DATA) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const handleLoaded = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error("Failed to prepare webcam stream"));
      };

      const cleanup = () => {
        video.removeEventListener("loadeddata", handleLoaded);
        video.removeEventListener("error", handleError);
      };

      video.addEventListener("loadeddata", handleLoaded, { once: true });
      video.addEventListener("error", handleError, { once: true });
    });
  }, [webcamVideoRef]);

  const captureFrameBytes = useCallback(async () => {
    const video = webcamVideoRef.current;
    if (!video) {
      return null;
    }

    const frameWidth = video.videoWidth || width;
    const frameHeight = video.videoHeight || height;

    if (frameWidth === 0 || frameHeight === 0) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.drawImage(video, 0, 0, frameWidth, frameHeight);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/jpeg", 0.9)
    );

    if (!blob) {
      return null;
    }

    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }, [height, webcamVideoRef, width]);

  const handleFrameReceived = useCallback(
    async (data: ArrayBuffer | Blob) => {
      const blob =
        data instanceof Blob
          ? data
          : new Blob([data], { type: "image/jpeg" });

      recordedBlobsRef.current.push(blob);
      if (recordedBlobsRef.current.length > MAX_RECORDED_FRAMES) {
        recordedBlobsRef.current = recordedBlobsRef.current.slice(
          -MAX_RECORDED_FRAMES
        );
      }

      frameCountRef.current += 1;
      lastFrameTimeRef.current = Date.now();

      if (!isLiveDrawingRef.current) {
        return;
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        return;
      }

      try {
        const bitmap = await createImageBitmap(blob);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      } catch (error) {
        console.error("Failed to render frame", error);
      }
    },
    []
  );

  const { connect, disconnect, createSendParams, startFrameExtraction } =
    useWebSocket({
      appAlias: FAL_APP_ALIAS,
      onFrameReceived: handleFrameReceived,
    });

  const endLiveSession = useCallback(() => {
    if (liveTimeoutRef.current) {
      clearTimeout(liveTimeoutRef.current);
      liveTimeoutRef.current = null;
    }
    liveEndTimeRef.current = Date.now();
    isLiveDrawingRef.current = false;
    disconnect("live session complete");
  }, [disconnect]);

  const clearCanvas = useCallback(() => {
    stopRecordedPlayback();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      const fallbackWidth =
        typeof window !== "undefined" ? window.innerWidth : 1920;
      const fallbackHeight =
        typeof window !== "undefined" ? window.innerHeight : 1080;
      if (canvas.width === 0 || canvas.height === 0) {
        canvas.width = fallbackWidth;
        canvas.height = fallbackHeight;
      }
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    setPhase("live");
  }, [stopRecordedPlayback]);

  const startPlaybackLoop = useCallback(() => {
    isLiveDrawingRef.current = true;
  }, []);

  const stopPlaybackLoop = useCallback(() => {
    isLiveDrawingRef.current = false;
    if (liveTimeoutRef.current) {
      clearTimeout(liveTimeoutRef.current);
      liveTimeoutRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    recordedBlobsRef.current = [];
    frameCountRef.current = 0;
    isLiveDrawingRef.current = true;
    liveStartTimeRef.current = Date.now();
    liveEndTimeRef.current = null;
    if (liveTimeoutRef.current) {
      clearTimeout(liveTimeoutRef.current);
    }
    liveTimeoutRef.current = setTimeout(() => {
      endLiveSession();
    }, LIVE_DURATION_MS);
  }, [endLiveSession]);

  const stopRecording = useCallback(() => {
    if (liveTimeoutRef.current) {
      clearTimeout(liveTimeoutRef.current);
      liveTimeoutRef.current = null;
    }
    isLiveDrawingRef.current = false;
    liveEndTimeRef.current = liveEndTimeRef.current ?? Date.now();
    stopWebcam();

    if (recordedBlobsRef.current.length === 0) {
      setPhase("idle");
      return;
    }

    recordedBlobsRef.current = recordedBlobsRef.current.slice(
      -MAX_RECORDED_FRAMES
    );

    void startRecordedPlayback();
  }, [startRecordedPlayback, stopWebcam]);

  const startFrameExtractionWrapper = useCallback(
    (fps: number = INPUT_FPS) => {
      startFrameExtraction(fps, captureFrameBytes, {
        strength: STREAM_STRENGTH,
        prompt: PROMPT,
        numBlocks: NUM_BLOCKS,
      });
    },
    [captureFrameBytes, startFrameExtraction]
  );

  const updateLastFrameTime = useCallback(() => {
    lastFrameTimeRef.current = Date.now();
  }, []);

  const startLiveSession = useCallback(async () => {
    if (isGenerating || phase === "live") {
      return;
    }

    try {
      await startWebcam();
      await waitForVideoReady();
    } catch (error) {
      console.error("Failed to access webcam", error);
      setPhase("idle");
      return;
    }

    const video = webcamVideoRef.current;
    if (!video) {
      setPhase("idle");
      return;
    }

    const videoWidth = video.videoWidth || width;
    const videoHeight = video.videoHeight || height;
    setWidth(videoWidth);
    setHeight(videoHeight);

    const startFrame = await captureFrameBytes();
    if (!startFrame) {
      console.error("Unable to capture initial webcam frame");
      setPhase("idle");
      stopWebcam();
      return;
    }

    setIsGenerating(true);

    const sendParams = createSendParams(
      {
        prompt: PROMPT,
        width: videoWidth,
        height: videoHeight,
        numBlocks: NUM_BLOCKS,
        seed: "",
        strength: STREAM_STRENGTH,
        mode: "webcam",
        startFrame,
        inputFps: INPUT_FPS,
        onWidthChange: setWidth,
        onHeightChange: setHeight,
      },
      {
        clearCanvas,
        startRecording,
        startPlaybackLoop,
        updateLastFrameTime,
        extractFrameBytes: captureFrameBytes,
        startFrameExtraction: startFrameExtractionWrapper,
        setIsGenerating,
      }
    );

    try {
      await connect(sendParams, {
        stopPlaybackLoop,
        stopRecording,
        setIsGenerating,
      });
    } catch (error) {
      console.error("Failed to start realtime session", error);
      setIsGenerating(false);
      setPhase("idle");
      stopRecordedPlayback();
      stopWebcam();
    }
  }, [
    captureFrameBytes,
    clearCanvas,
    connect,
    createSendParams,
    isGenerating,
    phase,
    setIsGenerating,
    startFrameExtractionWrapper,
    startPlaybackLoop,
    startRecording,
    startWebcam,
    stopPlaybackLoop,
    stopRecordedPlayback,
    stopRecording,
    stopWebcam,
    updateLastFrameTime,
    waitForVideoReady,
    webcamVideoRef,
    width,
    height,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        void startLiveSession();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [startLiveSession]);

  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frameId: number | null = null;
    let imageData: ImageData | null = null;
    let buffer: Uint32Array | null = null;

    const resize = () => {
      canvas.width = window.innerWidth || 1920;
      canvas.height = window.innerHeight || 1080;
      imageData = ctx.createImageData(canvas.width, canvas.height);
      buffer = new Uint32Array(imageData.data.buffer);
    };

    const render = () => {
      if (phase !== "idle" || !imageData || !buffer) {
        return;
      }

      for (let i = 0; i < buffer.length; i += 1) {
        const gray = (Math.random() * 255) | 0;
        buffer[i] = (255 << 24) | (gray << 16) | (gray << 8) | gray;
      }

      ctx.putImageData(imageData, 0, 0);
      frameId = requestAnimationFrame(render);
    };

    if (phase === "idle") {
      resize();
      window.addEventListener("resize", resize);
      render();
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", resize);
    };
  }, [phase]);

  useEffect(() => {
    return () => {
      if (liveTimeoutRef.current) {
        clearTimeout(liveTimeoutRef.current);
      }
      stopRecordedPlayback();
      disconnect("cleanup");
      stopWebcam();
    };
  }, [disconnect, stopRecordedPlayback, stopWebcam]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas
        ref={staticCanvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ display: phase === "idle" ? "block" : "none" }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ display: phase === "idle" ? "none" : "block" }}
      />
      <video
        ref={webcamVideoRef}
        autoPlay
        playsInline
        muted
        className="hidden"
      />
    </div>
  );
}
