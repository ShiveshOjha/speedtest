import 'isomorphic-fetch';
import { nodeFetch } from '../../utils/nodeRequest.js';

export default class ReachabilityEngine {
  constructor(targetUrl, { timeout = -1, fetchOptions = {}, localAddress = null } = {}) {
    let finished = false;
    const finish = ({ reachable, ...rest }) => {
      if (finished) return;
      finished = true;
      this.onFinished({
        targetUrl,
        reachable,
        ...rest
      });
    };

    const finalFetchOptions = {
      ...fetchOptions,
      ...(localAddress ? { localAddress } : {})
    };

    const isNodeFetch = !!localAddress;
    console.log(`[ReachabilityEngine] Using ${isNodeFetch ? 'nodeFetch' : 'isomorphic-fetch'} with localAddress:`, localAddress);

    (isNodeFetch ? nodeFetch : fetch)(targetUrl, finalFetchOptions)
      .then(response => {
        finish({
          reachable: true,
          response
        });
      })
      .catch(error => {
        finish({
          reachable: false,
          error
        });
      });

    timeout > 0 &&
      setTimeout(
        () => finish({ reachable: false, error: 'Request timeout' }),
        timeout
      );
  }

  // Public attributes
  onFinished = () => {};
}
