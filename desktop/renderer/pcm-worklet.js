class LiveTalkingPcm extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const samples = inputs[0]?.[0];
    if (samples?.length) this.port.postMessage(Float32Array.from(samples));
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('livetalking-pcm', LiveTalkingPcm);
