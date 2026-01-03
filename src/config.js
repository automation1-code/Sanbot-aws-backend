export const sessionConfig = {
  type: "realtime",
  model: "gpt-realtime",
  output_modalities: ["audio", "text"],
  audio: {
    input: {
      turn_detection: {
        type: "semantic_vad"
      }
    },
    output: {
      voice: "marin"
    }
  }
};
