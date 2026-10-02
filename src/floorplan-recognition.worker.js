import { recognizeFloorplan } from './floorplan-recognition.js';

self.onmessage = ({ data: { image, options } }) => {
  try {
    self.postMessage({ result: recognizeFloorplan(image, options) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
