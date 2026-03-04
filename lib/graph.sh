echo '{
    "children": [
      { "id": "t1", "title": "Track One",  "border": "double",   "shadow": true, "children": ["Instant HTML5"] },
      { "id": "t2", "title": "Track Two",  "border": "double", "shadow": true, "children": ["Gapless Web Audio"] }
    ],
    "connections": [
      { "from": "t1", "to": "t2", "label": "preload" }
    ]
  }' | npx box-of-rain --svg > artifacts/graph.svg