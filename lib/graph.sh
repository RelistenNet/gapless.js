echo '{
    "children": [
      { "id": "t1", "title": "Track One",   "border": "double", "shadow": true, "children": ["Instant HTML5", "↓", "Web Audio"] },
      { "id": "t2", "title": "Track Two",   "border": "double", "shadow": true, "children": ["Web Audio"] },
      { "id": "t3", "title": "Track Three", "border": "double", "shadow": true, "children": ["Web Audio"] }
    ],
    "connections": [
      { "from": "t1", "to": "t2", "label": "gapless" },
      { "from": "t2", "to": "t3", "label": "gapless" }
    ]
  }' | npx box-of-rain --svg > artifacts/graph.svg
