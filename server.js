const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Server configuration
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer((req, res) => {
  // Serve the viewer HTML page
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'viewer.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Server error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Track connections
let esp32Socket = null;
const viewerSockets = new Set();

console.log('🐭 Rat Cam Cloud Relay Server');
console.log('=============================');

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const type = url.searchParams.get('type');
  
  if (type === 'camera') {
    // ESP32-CAM connection
    if (esp32Socket) {
      // Already have a camera, close old one
      console.log('⚠️  Replacing existing camera connection');
      esp32Socket.close();
    }
    
    esp32Socket = ws;
    console.log('📷 ESP32-CAM connected!');
    
    ws.on('message', (message) => {
      // Broadcast camera frames to all viewers
      viewerSockets.forEach((viewer) => {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(message);
        }
      });
    });
    
    ws.on('close', () => {
      console.log('📷 ESP32-CAM disconnected');
      esp32Socket = null;
      // Notify viewers
      viewerSockets.forEach((viewer) => {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(JSON.stringify({ type: 'camera-offline' }));
        }
      });
    });
    
    ws.on('error', (err) => {
      console.error('❌ Camera error:', err.message);
    });
    
    // Send acknowledgment to camera
    ws.send(JSON.stringify({ type: 'connected' }));
    
  } else if (type === 'viewer') {
    // Browser viewer connection
    viewerSockets.add(ws);
    console.log(`👀 Viewer connected (total: ${viewerSockets.size})`);
    
    ws.on('message', (message) => {
      // Relay commands from viewer to ESP32
      if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
        esp32Socket.send(message);
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
    
    // Send current camera status
    if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'camera-online' }));
    } else {
      ws.send(JSON.stringify({ type: 'camera-offline' }));
    }
    
  } else {
    // Unknown connection type
    console.log('⚠️  Unknown connection type, closing');
    ws.close();
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('');
  console.log('ESP32 connects to:  ws://YOUR_SERVER/ws?type=camera');
  console.log('Browser opens:      http://YOUR_SERVER/');
  console.log('');
  console.log('🐭 Waiting for your rats to appear...');
});
