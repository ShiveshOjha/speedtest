import 'isomorphic-fetch';
import { nodeFetch } from '../../utils/nodeRequest.js';

class PromiseEngine {
  constructor(promiseFn) {
    if (!promiseFn) throw new Error(`Missing operation to perform`);

    this.#promiseFn = promiseFn;
    this.play();
  }

  // Public methods
  pause() {
    this.#cancelCurrent();
    this.#setRunning(false);
  }

  stop() {
    this.pause();
  }

  play() {
    if (!this.#running) {
      this.#setRunning(true);
      this.#next();
    }
  }

  // Internal state
  #running = false;
  #currentPromise = undefined;
  #promiseFn;

  // Internal methods
  #setRunning(running) {
    if (running !== this.#running) {
      this.#running = running;
    }
  }

  #next() {
    const curPromise = (this.#currentPromise = this.#promiseFn().then(() => {
      !curPromise._cancel && this.#next();
    }));
  }

  #cancelCurrent() {
    const curPromise = this.#currentPromise;
    curPromise && (curPromise._cancel = true);
  }
}

class LoadNetworkEngine {
  constructor({ download, upload, localAddress = null } = {}) {
    // Expected attrs for each: { apiUrl, chunkSize }
    if (!download && !upload)
      throw new Error('Missing at least one of download/upload config');

    [
      [download, 'download'],
      [upload, 'upload']
    ]
      .filter(([cfg]) => cfg)
      .forEach(([cfg, type]) => {
        const { apiUrl, chunkSize } = cfg;
        if (!apiUrl) throw new Error(`Missing ${type} apiUrl argument`);
        if (!chunkSize) throw new Error(`Missing ${type} chunkSize argument`);
      });

    const getLoadEngine = ({ apiUrl, qsParams = {}, fetchOptions = {} }) => {
      const finalFetchOptions = {
        ...fetchOptions,
        ...(localAddress ? { localAddress } : {})
      };
      
      return new PromiseEngine(() => {
        const url = `${apiUrl}?${Object.entries(qsParams)
          .map(([k, v]) => `${k}=${v}`)
          .join('&')}`;

        const isNodeFetch = !!localAddress;
        console.log(`[LoadNetworkEngine] Using ${isNodeFetch ? 'nodeFetch' : 'isomorphic-fetch'} with localAddress:`, localAddress);

        return (isNodeFetch ? nodeFetch : fetch)(url, finalFetchOptions).then(r => {
          if (!r.ok) throw Error(r.statusText);
          return r.text();
        });
      });
    };

    download &&
      this.#engines.push(
        getLoadEngine({
          apiUrl: download.apiUrl,
          qsParams: { bytes: `${download.chunkSize}` }
        })
      );

    upload &&
      this.#engines.push(
        getLoadEngine({
          apiUrl: upload.apiUrl,
          fetchOptions: {
            method: 'POST',
            body: '0'.repeat(upload.chunkSize)
          }
        })
      );
  }

  // Public attributes
  qsParams = {}; // additional query string params to include in the requests
  fetchOptions = {}; // additional options included in the requests

  // Public methods
  pause() {
    this.#engines.forEach(engine => engine.pause());
  }

  stop() {
    this.pause();
  }

  play() {
    this.#engines.forEach(engine => engine.play());
  }

  // Internal state
  #engines = [];
}

export default LoadNetworkEngine;
