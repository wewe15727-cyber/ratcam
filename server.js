const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Server configuration
const PORT = process.env.PORT || 3000;

// Track state
let latestFrame = null;       // Most recent JPEG frame from camera
let cameraOnline = false;     // Is camera currently sending frames?
let lastFrameTime = 0;        // When did we last get a frame?
let commands = '';            // Pending commands for ESP32 (LED on/off)

console.log('🐭 Rat Cam Cloud Relay Server');
console.log('=============================');

// Create HTTP server
const server = http.createServer((req, reqRes) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Serve the viewer HTML page
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'viewer.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        reqRes.writeHead(500);
        reqRes.end('Server error');
        return;
      }
      reqRes.writeHead(200, { 'Content-Type': 'text/html' });
      reqRes.end(data);
    });
    return;
  }
  
  // ESP32-CAM sends frames via HTTP POST
  if (url.pathname === '/camera/stream' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const frame = Buffer.concat(chunks);
      latestFrame = frame;
      cameraOnline = true;
      lastFrameTime = Date.now();
      
      // Broadcast to WebSocket viewers
      viewerSockets.forEach((viewer) => {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(frame);
        }
      });
      
      reqRes.writeHead(200, { 'Content-Type': 'text/plain' });
      reqRes.end('OK');
    });
    return;
  }
  
  // ESP32-CAM polls for commands
  if (url.pathname === '/camera/commands' && req.method === 'GET') {
    const cmd = commands;
    commands = '';  // Clear after reading
    reqRes.writeHead(200, { 'Content-Type': 'text/plain' });
    reqRes.end(cmd || 'none');
    return;
  }
  
  // Set LED command (from viewer)
  if (url.pathname === '/camera/led' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (body.indexOf('on') >= 0) {
        commands = 'led=on';
        console.log('💡 LED ON command queued');
      } else {
        commands = 'led=off';
        console.log('💡 LED OFF command queued');
      }
      reqRes.writeHead(200, { 'Content-Type': 'text/plain' });
      reqRes.end('OK');
    });
    return;
  }
  
  // Get latest snapshot
  if (url.pathname === '/camera/snapshot' && req.method === 'GET') {
    if (latestFrame) {
      reqRes.writeHead(200, { 'Content-Type': 'image/jpeg' });
      reqRes.end(latestFrame);
    } else {
      reqRes.writeHead(503, { 'Content-Type': 'text/plain' });
      reqRes.end('No frame available');
    }
    return;
  }
  
  // Health check
  if (url.pathname === '/health') {
    const online = (Date.now() - lastFrameTime) < 10000;
    reqRes.writeHead(200, { 'Content-Type': 'application/json' });
    reqRes.end(JSON.stringify({ 
      camera: online ? 'online' : 'offline', 
      viewers: viewerSockets.size,
      lastFrame: lastFrameTime 
    }));
    return;
  }
  
  reqRes.writeHead(404);
  reqRes.end('Not found');
});

// WebSocket server for browser viewers
const wss = new WebSocketServer({ server });
const viewerSockets = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const type = url.searchParams.get('type');
  
  if (type === 'viewer') {
    // Browser viewer connection
    viewerSockets.add(ws);
    console.log(`👀 Viewer connected (total: ${viewerSockets.size})`);
    
    // Send current camera status
    if (cameraOnline && (Date.now() - lastFrameTime) < 10000) {
      ws.send(JSON.stringify({ type: 'camera-online' }));
      // Send latest frame immediately
      if (latestFrame) {
        ws.send(latestFrame);
      }
    } else {
      ws.send(JSON.stringify({ type: 'camera-offline' }));
    }
    
    ws.on('message', (message) => {
      // Commands from viewer (LED control, etc.)
      try {
        const data = JSON.parse(message.toString());
        if (data.led !== undefined) {
          commands = data.led ? 'led=on' : 'led=off';
          console.log(`💡 LED ${data.led ? 'ON' : 'OFF'} command queued`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });
    
    ws.on('close', () => {
      viewerSockets.delete(ws);
      console.log(`👀 Viewer disconnected (total: ${viewerSockets.size})`);
    });
    
    ws.on('error', (err) => {
      console.error('❌ Viewer error:', err.message);
      viewerSockets.delete(ws);
    });
    
  } else {
    console.log('⚠️  Unknown connection type, closing');
    ws.close();
  }
});

// Camera heartbeat check
setInterval(() => {
  if (cameraOnline && (Date.now() - lastFrameTime) > 15000) {
    console.log('📷 Camera appears offline (no frames for 15s)');
    cameraOnline = false;
    viewerSockets.forEach((viewer) => {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(JSON.stringify({ type: 'camera-offline' }));
      }
    });
  }
}, 10000);

// Start server
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('');
  console.log('ESP32 pushes frames to: POST https://YOUR_SERVER/camera/stream');
  console.log('Browser opens:          https://YOUR_SERVER/');
  console.log('');
  console.log('🐭 Waiting for your rats to appear...');
});
