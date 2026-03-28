export { EpisodePipeline } from './pipeline.js';

export default {
  async queue(batch, env) {
    // TODO: implement in Task 9
  },

  async fetch(request, env) {
    return new Response('roe-pipeline worker', { status: 200 });
  },
};
