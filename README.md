# Jug_Demo Readme

Handover notes:

**Build Instructions/Requirements:**
Editor - I'd advise VS Code

NPM, can install this from: https://github.com/coreybutler/nvm-windows/releases/download/1.1.12/nvm-setup.exe

Once npm is installed you'll need to install the following packages:

Cytoscape: `npm install --save cytoscape`

Dygraphs: `npm install --save dygraphs`

Vite: `npm install --save vite`

Typescript: `npm install -g typescript`

Also handy to have the types for typescript:

`npm install --save-dev @types/cytoscape`

`npm install --save-dev @types/dygraphs`

**Run:**
To run a debug build via Vite, use `npm run dev` which will build & compile to JS and kick off a dev server.
The output will show: `Local: http://localhost:nnnn/` which you can ctrl+click to open.

While you can run `npm run build` to build the complete project assets in the dist folder, then use python to start a server it's just easier for the demo to run dev. Never sorted out project dependencies and dirs.
If this is necessary someone with JS build knowledge should be able to get it up and running in short order.

----

**Usage:**

On initial load you'll be presented with a splash screen and no data loaded.
Click on the burger to drop down the left menu pane.
From there you can load the enron data set, categorize entities and load the (fake) NER data set.
You can also filter by degree from here.
This menu also opens via '\`'.

Pressing space or clicking on an edge or node will open the right info pane.
This shows a (non-functional) search box and listbox.
This is populated with all connected edges when a node is clicked.
And populated with all connected edges between two nodes, when an edge is selected.
Clicking on a node will highlight all edges to/from that node.
Clicking on an edge will highlight all edges between the two nodes at the end of that edge.

In main.ts, a constant `JsonFileSuffix` is used to declare the local 'enron' data files.

**Bugs:**
I've recently added tooltips for edges, a delay is needed as hovering over multiple edges can trigger multiple onEdgeHover's, and by the time the mouse has left the edge, the onEndHover never gets triggered, leaving the tooltip displayed. A click on empty space will remove any tooltip though.

<Todo> Layout iterations / graph settings /
