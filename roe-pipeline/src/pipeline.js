export class EpisodePipeline {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response('EpisodePipeline stub', { status: 200 });
  }
}
