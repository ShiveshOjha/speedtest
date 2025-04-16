import https from 'https';
import { performance } from 'perf_hooks';
import dns from 'dns';
import { promisify } from 'util';
import net from 'net';
import url from 'url';

class NodeResponse {
  constructor(response, body, timings) {
    this.status = response.statusCode;
    this.statusText = response.statusMessage;
    this.headers = new Map();
    this.ok = this.status >= 200 && this.status < 300;
    this.body = body;
    this.bodyUsed = false;
    this.type = 'basic';
    this.url = response.url;
    this.timings = timings;
    this.rawResponse = response;

    // Convert headers to Map
    Object.entries(response.headers).forEach(([key, value]) => {
      this.headers.set(key.toLowerCase(), value);
    });
  }

  text() {
    if (this.bodyUsed) {
      return Promise.reject(new TypeError('Body already used'));
    }
    this.bodyUsed = true;
    return Promise.resolve(this.body);
  }

  json() {
    return this.text().then(text => JSON.parse(text));
  }

  clone() {
    return new NodeResponse({
      statusCode: this.status,
      statusMessage: this.statusText,
      headers: Object.fromEntries(this.headers),
      url: this.url
    }, this.body, this.timings);
  }
}

class NodePerformanceResourceTiming {
  constructor(timings, url, response, bodySize = 0) {
    this.name = url;
    this.entryType = 'resource';
    this.startTime = timings.startTime;
    this.duration = timings.endTime - timings.startTime;
    this.initiatorType = 'fetch';
    this.nextHopProtocol = response.httpVersion === '2.0' ? 'h2' : 'http/1.1';
    this.workerStart = 0;
    this.redirectStart = 0;
    this.redirectEnd = 0;
    this.fetchStart = timings.startTime;
    this.domainLookupStart = timings.dnsStart;
    this.domainLookupEnd = timings.dnsEnd;
    this.connectStart = timings.tcpConnectStart;
    this.secureConnectionStart = timings.tlsHandshakeStart;
    this.connectEnd = timings.tcpConnectEnd;
    this.requestStart = timings.startTime;
    this.responseStart = timings.firstByteTime;
    this.responseEnd = timings.endTime;

    // Calculate latency (TTFB - requestStart)
    this.latency = this.responseStart - this.requestStart;

    // Calculate transferSize based on response headers and body size
    if (response.headers['content-length']) {
      this.transferSize = parseInt(response.headers['content-length']);
    } else if (response.headers['transfer-encoding'] === 'chunked') {
      // For chunked encoding, use actual body size plus estimated header size
      this.transferSize = bodySize + 200; // 200 bytes for headers is a reasonable estimate
    } else {
      this.transferSize = bodySize;
    }

    // For empty responses (like 0 byte test), use header size
    if (this.transferSize === 0 && response.headers['server-timing']) {
      const serverTiming = response.headers['server-timing'];
      const match = serverTiming.match(/sent_bytes=(\d+)/);
      if (match) {
        this.transferSize = parseInt(match[1]);
      }
    }

    this.encodedBodySize = bodySize;
    this.decodedBodySize = bodySize;

  }
}

const lookup = promisify(dns.lookup);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function measureDNS(hostname) {
  const start = performance.now();
  await lookup(hostname);
  return performance.now() - start;
}

async function measureTCPConnect(host, port, localAddress) {
  
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    
    socket.on('error', (error) => {
      console.error('Socket error:', {
        message: error.message,
        code: error.code,
        syscall: error.syscall,
        address: error.address,
        port: error.port
      });
      reject(error);
    });
    
    socket.on('connect', () => {
      socket.end();
      resolve(performance.now() - start);
    });
    
    const options = {
      port: port || 443,
      host,
      localAddress,
      family: 4,  // Force IPv4
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, {
          family: 4,
          all: false
        }, callback);
      }
    };
    
    try {
      socket.connect(options);
    } catch (error) {
      console.error('Failed to initiate connection:', error);
      reject(error);
    }
  });
}

export async function nodeFetch(urlStr, options = {}) {
  
  const start = performance.now();
  const parsedUrl = url.parse(urlStr);
  const { hostname, port, path } = parsedUrl;
  const { localAddress, ...httpsOptions } = options;
  const timings = {
    startTime: performance.now()
  };
  
  try {
    // Measure DNS lookup time
    timings.dnsStart = performance.now();
    const dnsResult = await promisify(dns.lookup)(hostname, { family: 4 });
    timings.dnsEnd = performance.now();
    const dnsTime = timings.dnsEnd - timings.dnsStart;
    
    // Measure TCP connect time
    timings.tcpConnectStart = performance.now();
    const tcpTime = await measureTCPConnect(hostname, port, localAddress);
    timings.tcpConnectEnd = timings.tcpConnectStart + tcpTime;
    
    // TLS handshake start time
    timings.tlsHandshakeStart = timings.tcpConnectEnd;
    
    return new Promise((resolve, reject) => {
      const requestOptions = {
        ...httpsOptions,
        hostname,
        port: port || 443,
        path: path || '/',
        method: options.method || 'GET',
        localAddress,
        family: 4,
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, {
            family: 4,
            all: false
          }, callback);
        }
      };

      let body = '';
      let bodySize = 0;
      let firstByteTime = null;
      let tlsHandshakeEnd = null;

      const req = https.request(requestOptions, (res) => {
        // Capture TLS handshake end time when the socket is established
        if (res.socket && res.socket.encrypted) {
          tlsHandshakeEnd = performance.now();
          timings.tlsHandshakeEnd = tlsHandshakeEnd;
          // For upload requests, this is our upload latency
          if (options.method === 'POST') {
            timings.uploadLatency = tlsHandshakeEnd - timings.startTime;
          }
        }

        res.on('data', (chunk) => {
          if (!firstByteTime) {
            firstByteTime = performance.now();
            timings.firstByteTime = firstByteTime;
            // For download requests, this is our download latency
            if (options.method === 'GET') {
              timings.downloadLatency = firstByteTime - timings.startTime;
            }
          }
          body += chunk;
          bodySize += chunk.length;
        });

        res.on('end', () => {
          timings.endTime = performance.now();
          timings.transferSize = bodySize;

          const response = new NodeResponse(res, body, timings);
          const perfEntry = new NodePerformanceResourceTiming(timings, urlStr, res, body.length);
          resolve(response);
        });
      });

      req.on('error', (error) => {
        console.error('Request error:', error);
        reject(error);
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  } catch (error) {
    console.error('Request failed:', error);
    reject(error);
  }
}

export {
  NodeResponse,
  NodePerformanceResourceTiming
};
