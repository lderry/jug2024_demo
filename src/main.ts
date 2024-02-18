import cytoscape, { EventObject } from 'cytoscape';
import Dygraph from 'dygraphs';

// #region Constants

// Paths
const JsonFileSuffix			= 'small'; // test, test2, small, fullWARNING
const EntityDataPath			= './JSON/entityData_' + JsonFileSuffix + '.json';
const EventDataPath				= './JSON/eventData_' + JsonFileSuffix + '.json';
const NEREntityDataPath			= './JSON/NERentityData.json';
const NEREventDataPath			= './JSON/NEReventData.json';

// Node Colors
const DefaultNodeColor			= 'rgb(75, 75, 75)';	// Grey - All nodes are this colour prior to node categorization
const EnronEmailNodeColor		= 'rgb(45, 105, 160)';	// Blue
const ExternalEmailNodeColor 	= 'rgb(164, 22, 69)';	// Red
const NERPersonNodeColor		= 'rgb(95, 160, 78)';	// Green
const NEREmailNodeColor			= 'rgb(175, 116, 232)';	// Purple
const NERCompanyNodeColor		= 'rgb(146, 159, 165)';	// Grey
const NERAgencyNodeColor		= 'rgb(208, 121, 18)';	// Yellow

// Selector Classes
const NERClass					= 'NER';
const NERPersonClass			= 'NERPerson';
const NEREmailClass				= 'NEREmail';
const NERCompanyClass			= 'NERCompany';
const NERAgencyClass			= 'NERAgency';
const selectedNodePrimaryClass	= 'selectedNodePrimary';
const selectedNodeSecondaryClass= 'selectedNodeSecondary';
const selectedEdgeClass			= 'selectedEdgePrimary';

const minNodeSize = 40;
const maxNodeSize = 240;

const tooltipTimoutInMsecs		= 500;
const tooltipOffsetX			= 25;
const tooltipOffsetY			= 10;

const earliestDate: number = 911520000000;	// 911520000000 is 20/11/1998 in decimal, which is the first real data point of interest

const DEBUG_Fetch 	= false;
const DEBUG_Calls 	= false;
const DEBUG_Timebar	= false;
const DEBUG_Filter	= false;

// HTML Elements
const GraphDivId				= 'graphContainer';
const TimebarDivId 				= 'timelineContainer';
const menuPanelId 				= 'west';
const infoPanelId 				= 'east';
const searchPanelId 			= 'search-results-list';
const infoPanelToggleArrowId 	= 'info-toggle';
const selectedElementInfoId 	= 'selectedElement-info';

// #endregion


// #region Preamble

let cs: cytoscape.Core;
let dg: Dygraph;

let enronNodes: IEntityItem[] = [];
let enronEvents: IEventItem[] = [];
let NERNodes: IEntityItem[] = [];
let NEREvents: IEventItem[] = [];

let sentCounts = new Map<string, string[]>(); // More precisely, 'target counts'
let NERsentCounts = new Map<string, string[]>();

//let dateCounts = new Map<number, number>();
//let dateCounts = new Map<number, { totalEvents: number, [key: string]: number }>();
let dateFrequencies = new Map<number, IDateCount>();

let nodeIdsInDateRange: number[] = [];
let removedNodeIds: number[] = [];
let previousRange: [number, number];

let minNodeRank: number = 0;
let maxNodeRank: number = 0;

interface IEntityItem {
	id		: string;
	name	: string;
	type	: string;
}

interface IEventItem {
	date		: string;
	subject		: string;
	message_id	: string;
	from		: string;
	to			: string;
	type		: string;
}

interface IDateCount {
	[key: string]: number;
	totalEvents: number;
}

let entityDataPromise	: Promise<IEntityItem[]>;
let eventDataPromise	: Promise<IEventItem[]>;
let NERentityDataPromise: Promise<IEntityItem[]>;
let NEReventDataPromise	: Promise<IEventItem[]>;

// #endregion


// #region Helper Functions

function isEnronEmailType(emailType: string): boolean {
	return emailType === 'EnronEmailAddress';
}

function isExternalEmailType(emailType: string): boolean {
	return emailType === 'ExternalEmailAddress';
}

function isNERType(type: string): boolean {
	if (type.length < 3) { return false; }
	const substr = type.slice(0, 3);
	
	return substr.startsWith(NERClass);

	/*return isNERPersonType(type)
		|| isNEREmailType(type)
		|| isNERCompanyType(type)
		|| isNERAgencyType(type);*/
}

function isNERPersonType(type: string): boolean {
	return type === 'NERPerson';
}

function isNEREmailType(type: string): boolean {
	return type === 'NEREmail';
}

function isNERCompanyType(type: string): boolean {
	return type === 'NERCompany';
}

function isNERAgencyType(type: string): boolean {
	return type === 'NERAgency';
}

function extractEmailDomain(email: string): string {
	//return email.substring(email.lastIndexOf('@') + 1);

	const regex = /@([^@<>\s]+)>?$/; // Match the domain after '@'
	const match = email.match(regex);
	if (match && match.length >= 2) {
		return match[1];
	}

	return email.substring(email.lastIndexOf('@') + 1); // Fallback
}

function getDarkerOf(rgbString: string): string {
	// Return a color 20% darker than param

	let dimBy = 0.8;
	const rgbaValues = rgbString.match(/\d+(\.\d+)?/g);
	if (rgbaValues && (rgbaValues.length === 3 || rgbaValues.length === 4)) {
		const [r, g, b] = rgbaValues.slice(0, 3).map(Number);
		return `rgba(${r*0.8},${g*0.8},${b*0.8})`;
	} else {
		throw new Error('Invalid RGB string format.');
	}

	return rgbString; // failure = return string unchanged
}

function truncateString(str: string, maxLength: number): string {
	if (str.length > maxLength) {
		return str.substring(0, maxLength - 3) + '...';
	} else {
		return str;
	}
}

function idealEdgeLengthFn(): number {
	return 100;
}

function nodeRepulsionFn(): number {
	return 150000;
}

function edgeElasticityFn(): number {
	return 200;
}

// Map rank value to node size
const mapRankToSize: cytoscape.Css.MapperFunction<cytoscape.NodeSingular, string | number> = (node) =>{
	const rank: number = node.data('rank');

	if (!rank || rank < 1) {
		return minNodeSize;
	}

	const normalisedRank = (rank - minNodeRank) / (maxNodeRank - minNodeRank);
	return normalisedRank * (maxNodeSize - minNodeSize) + minNodeSize;
}

// Get the current value of the degree slider element
function getDegree(): number {
	const slider = document.getElementById('slider') as HTMLInputElement;
	return +slider.value;
}

function getFormattedNodeEdges(node: cytoscape.NodeSingular): string[] {
	let strings: string[] = [];

	node.connectedEdges().forEach(edge => {
		let from: string = cs.getElementById(edge.data('source')).data('name');
		let to: string = cs.getElementById(edge.data('target')).data('name');
		let date: string = formatShortDate(edge.data('datetime'));
		let str = 'From: ' + from + ', To: ' + to + ', Subject: ' + edge.data('subject') + ', Date:' + date;
		// console.log(str);
		strings.push(str);
	});

	return strings;
}

function getSiblingEdges(edge: cytoscape.EdgeSingular): cytoscape.EdgeCollection {
	let edges: cytoscape.EdgeCollection;
	let nodeSourceId: string = cs.getElementById(edge.data('source')).id();
	let nodeTargetId: string = cs.getElementById(edge.data('target')).id();
	if (nodeSourceId && nodeTargetId) {
		return cs.filter(function(element, i) {
			return element.isEdge() && 
				( (nodeSourceId === element.data('source') && nodeTargetId === element.data('target')) ||
				  (nodeSourceId === element.data('target') && nodeTargetId === element.data('source') ) // Either direction
				);
		});
	}

	return edges;
}

function getFormattedEdgeSiblings(edge: cytoscape.EdgeSingular): string[] {
	
	let strings: string[] = [];
	let edges: cytoscape.EdgeCollection = getSiblingEdges(edge);
	
	edges.forEach(edge => {
		let date: string = formatShortDate(edge.data('datetime'));
		let id: string = edge.data('id');
		let subject: string = edge.data('subject');
		let type: string = edge.data('type');
		let str = 'Subject: ' + subject + 'Id: ' + id + ', Date: ' + date + ', Type: ' + type;
		// console.log(str);
		strings.push(str);
	});

	return strings;
}

// Format eg: '2000-07-17T07:51:00.000Z' to a more human-readable 'dd-mm-yyy hh-mm'
function formatDateWithTime(dateString: string): string {
	const date = new Date(dateString);
	const day = date.getDate().toString().padStart(2, '0');
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const year = date.getFullYear();
	const hours = date.getHours().toString().padStart(2, '0');
	const minutes = date.getMinutes().toString().padStart(2, '0');

	return `${day}-${month}-${year} ${hours}:${minutes}`;
}

// Format a short date 'dd-mm-yyyy'
function formatShortDate(dateString: string): string {
	const date = new Date(dateString);
	const day = date.getDate().toString().padStart(2, '0');
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const year = date.getFullYear();

	return `${day}-${month}-${year}`;
}

function hideSplash() {
	let splashContainer: HTMLElement = document.getElementById(GraphDivId);
	splashContainer.style.backgroundImage = 'none';
}

function clearElementInfo() {
	let nodeInfoElement = document.getElementById('selectedElement-info');
	if (nodeInfoElement) {
		nodeInfoElement.textContent = ' ';
	}
}

// #endregion


// #region Fetch JSON

async function fetchEnronData(): Promise<void> {
	
	await fetchEnronEntityData();
	await fetchEnronEventData();

	try {
		await Promise.all([entityDataPromise, eventDataPromise]);
	} finally {
		if (DEBUG_Fetch) { console.log(enronNodes.length + ' nodes loaded.'); }
		if (DEBUG_Fetch) { console.log(enronEvents.length + ' events loaded.'); }
		//console.log(timebarItems.length + ' timebar items loaded.');

		// Build our source map
		enronEvents.forEach(event => {
			if (event.from !== event.to) {
				if (sentCounts.has(event.from)) {
					sentCounts.get(event.from)!.push(event.to);
				} else {
					sentCounts.set(event.from, [event.to]);
				}
			}
		});
	}

	if (enronNodes.length === 0) {
		console.log('Error: No entities loaded');
		return;
	}
}

function fetchEnronEntityData(): void {
	if (DEBUG_Calls) { console.log('Fetching entities...'); }

	entityDataPromise = fetch(EntityDataPath)
	.then(response => response.json())
	.then((jsonData: IEntityItem[]) => {
	
		// Construct a collection of Nodes from the json data
		enronNodes = jsonData.map((item: IEntityItem) => ({
			id		: item.id,
			name	: item.name,
			type	: item.type
		}));

		return jsonData;
	})
	.catch(error => {
		console.error('Error fetching entity JSON data:', error)
		throw error;
	});
}

function fetchEnronEventData() {
	if (DEBUG_Calls) { console.log("Fetching events..."); }

	eventDataPromise = fetch(EventDataPath)
	.then(response => response.json())
	.then((jsonData: IEventItem[]) => {
		// Construct a collection of events from the json data
		enronEvents = jsonData.map((item: IEventItem) => ({
			date		: item.date,
			message_id	: item.message_id,
			subject		: item.subject,
			type		: item.type,
			from		: item.from,
			to			: item.to
		}));
	
	return jsonData;
	})
	.catch(error => {
		console.error('Error fetching event JSON data:', error)
		throw error;
	});
}

async function fetchNERData(): Promise<void> {
	await fetchNEREntityData();
	await fetchNEREventData();

	try {
		await Promise.all([NERentityDataPromise, NEReventDataPromise]);
	} finally {
		if (DEBUG_Fetch) { console.log(NERNodes.length + ' NER nodes loaded.'); }
		if (DEBUG_Fetch) { console.log(NEREvents.length + ' NER events loaded.'); }

		// Build our source map
		NEREvents.forEach(event => {
			if (event.from !== event.to) {
				if (NERsentCounts.has(event.from)) {
					NERsentCounts.get(event.from)!.push(event.to);
				} else {
					NERsentCounts.set(event.from, [event.to]);
				}
			}
		});
	}

	if (NERNodes.length === 0) {
		console.log('Error: No NER entities loaded');
		return;
	}
}

function fetchNEREntityData(): void {
	if (DEBUG_Calls) { console.log('Fetching NER entities...'); }

	NERentityDataPromise = fetch(NEREntityDataPath)
	.then(response => response.json())
	.then((jsonData: IEntityItem[]) => {
		NERNodes = jsonData.map((item: IEntityItem) => ({
			id		: item.id,
			name	: item.name,
			type	: item.type
		}));

		return jsonData;
	})
	.catch(error => {
		console.error('Error fetch NER entity JSON data:', error)
		throw error;
	});
}

function fetchNEREventData() {
	if (DEBUG_Calls) { console.log("Fetching NER events..."); }

	NEReventDataPromise = fetch(NEREventDataPath)
	.then(response => response.json())
	.then((jsonData: IEventItem[]) => {
		// Construct a collection of events from the json data
		NEREvents = jsonData.map((item: IEventItem) => ({
			date		: item.date,
			message_id	: item.message_id,
			subject		: item.subject,
			type		: item.type,
			from		: item.from,
			to			: item.to
		}));
	
	return jsonData;
	})
	.catch(error => {
		console.error('Error fetching NER event JSON data:', error)
		throw error;
	});
}

// #endregion


// #region Layouts

function runLayout_Cose() {
	if (!cs) {
		return;
	}

	let numEntities: number = cs.nodes().length;

	cs.layout({
		name: 'cose',
		animate: false, // faster if false
		refresh: 1,
		fit: true,
		padding: 30,
		boundingBox: undefined,
		nodeDimensionsIncludeLabels: false,
		randomize: false,
		componentSpacing: 80,
		nodeRepulsion: nodeRepulsionFn,
		nodeOverlap: 40,
		idealEdgeLength: idealEdgeLengthFn,
		edgeElasticity: edgeElasticityFn,
		nestingFactor: 1.2,
		gravity: 100,
		numIter: numEntities > 500 ? 5 : 200, // Huge effect on layout performance. Lower = faster but less cohesive layout
		initialTemp: 2000,
		coolingFactor: 0.95,
		minTemp: 1.0,
		ready: function() {
			//
		}
	}).run();
}

function runLayout_Grid() {
	if (!cs) {
		return;
	}

	cs.layout({
		name: 'grid',
		fit: true, // whether to fit the graph to the viewport
		padding: 30, // padding used on fit
		boundingBox: undefined, // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
		avoidOverlap: true, // prevents node overlap, may overflow boundingBox if not enough space
		avoidOverlapPadding: 10, // extra spacing around nodes when avoidOverlap: true
		nodeDimensionsIncludeLabels: true, // include the label when calculating node bounding boxes for the layout algorithm
		spacingFactor: undefined, // applies a multiplicative factor (>0) to expand or compress the overall area that the nodes take up
		condense: false, // uses all available space on false, uses minimal space on true
		rows: undefined, // force num of rows in the grid
		cols: undefined, // force num of columns in the grid
		//position: function(node){}, // returns { row, col } for element
		sort: function(a, b) { return b.data.weight - a.data.weight }, // .data('rank') - a.data('rank') },
		animate: false, // whether to transition the node positions
		animationDuration: 500 // duration of animation in ms if enabled
	}).run();
}

// #endregion


// #region Selectors

function getSelectors(): cytoscape.Stylesheet[] {

	// These guys determine the overall styling of the graph
	
	return [
		{
			selector: 'node',
			style: {
				'width': mapRankToSize,
				'height': mapRankToSize,
				'background-color': DefaultNodeColor,
				'border-color': '#AED6F1',
				'border-width': 3,
				'label': 'data(label)',
				'min-zoomed-font-size': 12.5,	// Minimum font size for the node labels to be visible
												// This can cause performance issues so should really be a function of num vis nodes
				'text-valign': 'bottom',
				'text-halign': 'center'
			}
		},
		{
			selector: 'edge',
			style: {
				'width': 3,
				'line-color': 'rgb(180,180,180)',
				'curve-style': 'haystack', 				// Cheapest edge to draw
				'haystack-radius': 0.3,					// Some overlap
				'line-opacity': 1,						// Lower opacity looks better for overlapping haystack edges but transparency is expensive
				'mid-target-arrow-shape': 'chevron',
				'mid-target-arrow-color': 'red'
			}
		},
		{
			selector: '.hidden',
			css: {
				'display': 'none'
			}
		},
		
		{
			selector: '.enronAddress',
			style: {
				'background-color': EnronEmailNodeColor,
			}
		},

		{
			selector: '.externalAddress',
			style: {
				'background-color': ExternalEmailNodeColor,
			}
		},

		/*{ // *** Performed by the slider & filterByDegree function instead
			selector: 'node[[degree = 0]]',
			css: {
				'display': 'none'
			}
		},*/

		// NER
		// TODO: NER Edges?
		// TODO: All NER nodes should be given a class so we can border them the same to visually separate them from the rest of the graph
		{
			selector: '.' + NERClass,
			style: {
				'border-color': 'rgb(255,0,0,1)',	// Override node's
				'border-width': 3,			// ditto
			}
		},

		{
			selector: '.' + NERPersonClass,
			style: {
				'background-color': NERPersonNodeColor,
			}
		},

		{
			selector: '.' + NEREmailClass,
			style: {
				'background-color': NEREmailNodeColor,
			}
		},

		{
			selector: '.' + NERCompanyClass,
			style: {
				'background-color': NERCompanyNodeColor,
			}
		},

		{
			selector: '.' + NERAgencyClass,
			style: {
				'background-color': NERAgencyNodeColor,
			}
		},

		// Selection
		{
			selector: '.' + selectedNodePrimaryClass,
			style: {
				'background-blacken': 0.5,
				'border-width': 20,
				'border-color': 'rgb(255,0,0)',
				'border-opacity': 0.1,
				'min-zoomed-font-size': 1
			}
		},

		{
			selector: '.' + selectedNodeSecondaryClass,
			style: {
				'background-blacken': 0.3,
				'border-width': 20,
				'border-color': 'rgb(255,55,55,0.01)',
				'border-opacity': 0.1,
				'min-zoomed-font-size': 1
			}
		},

		{
			selector: '.' + selectedEdgeClass,
			style: {
				'line-color': 'red',
				'line-opacity': 1,
				'mid-target-arrow-color': 'red',
				'width': 2
			}
		}
	];
}

// #endregion


// #region Graph Operations

function loadNodes(nodes: IEntityItem[]): void {

	let elements: cytoscape.ElementDefinition[] = [];

	cs.batch(async function() {
		nodes.forEach(node => {
			let numTargets = 0;

			if (node.id && sentCounts.has(node.id)) {
				numTargets = sentCounts.get(node.id)!.length;
			}

			if (minNodeRank === 0 || numTargets < minNodeRank) {
				minNodeRank = numTargets;
			}
			if (maxNodeRank === 0 || numTargets > maxNodeRank) {
				maxNodeRank = numTargets;
			}

			elements.push({
				group: 'nodes',
				data: {
					id: node.id,
					name: node.name,
					label: truncateString(node.name, 20),
					type: node.type,
					rank: numTargets
				}
			});
		});

		cs.add(elements);
	});
}

function loadEvents(events: IEventItem[]): void {
	
	let elements: cytoscape.ElementDefinition[] = [];

	cs.batch(function() {
		events.forEach(event => {
			if (event.from != event.to) {
				elements.push({
					group: 'edges',
					data: {
						id: event.message_id,
						source: event.from,
						target: event.to,
						datetime: event.date,
						msgId: event.message_id,
						subject: event.subject
					}
				});
			}
		});

		cs.add(elements);
	});
}

async function loadEnronData(): Promise<void> {
	await loadNodes(enronNodes);
	await loadEvents(enronEvents);
}

export async function loadNERData(): Promise<void> {
	await fetchNERData();
	await loadNodes(NERNodes);
	await loadEvents(NEREvents);

	runLayout_Cose();
}

function barChartPlotterFn(e: any) {
	var ctx = e.drawingContext;
	var points = e.points;
	var y_bottom = e.dygraph.toDomYCoord(0);

	ctx.fillStyle = e.color;

	// Find the minimum separation between x values
	// This determines the bar width
	let min_sep: number = Infinity;
	for (let i = 1; i < points.length; i++) {
		let sep = points[i].canvasx - points[i - 1].canvasx;
		if (sep < min_sep) {
			min_sep = sep;
		}
	}

	let bar_width: number = Math.floor(2.0 / 3 * min_sep);

	// Perform the plotting
	for (let i = 0; i < points.length; i++) {
		let p = points[i];
		let center_x = p.canvasx;
		ctx.fillRect(center_x - bar_width / 2, p.canvasy, bar_width, y_bottom - p.canvasy);
		ctx.strokeRect(center_x - bar_width / 2, p.canvasy, bar_width, y_bottom - p.canvasy);
	}
}

function withinRange(n: number, min: number, max: number): boolean {
	
	if (n < earliestDate) { return false; } // Ignore the early outlyers

	// Inclusive
	return n >= min && n <= max;
}

// Called on timebar change
function drawCallbackFn(dyg: Dygraph, is_initial: boolean) {
	if (is_initial) {
		return;
	}
	
	const currentRange: [number, number] = dyg.xAxisRange();
	if (previousRange && (currentRange[0] !== previousRange[0] || currentRange[1] !== previousRange[1])) {
		
		//nodeIdsInDateRange = []; // Unused
		
		let degree: number = getDegree();
		
		// Find all within range and observing degree filter
		cs.batch(function() {
		for (const [date, iDateCountVal] of dateFrequencies) {
			const withinCurrentRange = withinRange(date, currentRange[0], currentRange[1]);
			for (const id in iDateCountVal) {
				if (id !== 'totalEvents') {
					let node = cs.getElementById(id);
					if (abidesByDegreeFilter(node, degree)) { // Only modify those that pass the degree filter
						if (withinCurrentRange) {
							if (DEBUG_Timebar) { console.log('removing "hidden" class from ', id); }
							cs.getElementById(id).removeClass('hidden');
							//nodeIdsInDateRange.push(+id);
						} else {
							if (DEBUG_Timebar) { console.log('adding "hidden" class to ', id); }
							cs.getElementById(id).addClass('hidden');
						}
					}
				}
			}
		}
		});
	}
	previousRange = currentRange;
	
	//console.log("IDs in Range:", nodeIdsInDateRange.length);
}

// Adds node classes so as to provide coloring
export function categorizeNodes() {
	cs.batch(function() {
		cs.nodes().forEach(node => {
			if (isEnronEmailType(node.data('type'))) {
				node.addClass('enronAddress');
			}

			if (isExternalEmailType(node.data('type'))) {
				node.addClass('externalAddress');
			}

			if (isNERPersonType(node.data('type'))) {
				node.addClass('NERPerson');
			}

			if (isNEREmailType(node.data('type'))) {
				node.addClass('NEREmail');
			}

			if (isNERCompanyType(node.data('type'))) {
				node.addClass('NERCompany');
			}

			if (isNERAgencyType(node.data('type'))) {
				node.addClass('NERAgency');
			}
		});
	});
}

// Does this node pass our degree filter?
function abidesByDegreeFilter(node: cytoscape.NodeSingular, degree: number): boolean {
	if (node.degree(false) < degree) {
		return false;
	}
	return true;
}

// filter the graph by degree filter and dygraphs date range
export async function filterGraph(): Promise<void> {
	// Filter the graph
	await filterByDegree(cs.nodes());
	
	// Now filter the timebar, which means we have to load new data
	// Which means we have to build a date frequency map...
	dateFrequencies.clear();
	dateFrequencies = getTimebarDateFrequencies();

	// Then sort them...
	const sortedKeys = Array.from(dateFrequencies.keys()).sort((a, b) => +a - +b);

	let data: [Date, number][] = createDygraphData(sortedKeys);

	dg.updateOptions({file: data}); // Finally update dygraphs with the 'filtered' data
}

// add / remove the hidden class based on current degree filter
async function filterByDegree(nodes: cytoscape.NodeCollection): Promise<void> {
	const degree: number = getDegree();
	
	if (DEBUG_Filter) { console.log('filtering by degree ', degree); }

	cs.batch(function() {
		nodes.forEach(node => {
			if (node.degree(false) < degree) {
				if (DEBUG_Filter) { console.log('node ', node.data('id'), ' has degree less than ', degree, ', hiding the node.'); }
				node.addClass('hidden');
			} else {
				node.removeClass('hidden');
			}
		});
	});
}

// add / remove the hidden class based on timebar range
function getTimebarDateFrequencies(): Map<number, IDateCount> {

	let degree: number = getDegree();

	dateFrequencies.clear();

	const date = new Date();

	// bucket the events into days
	enronEvents.forEach(event => {
		date.setTime(Date.parse(event.date));
		date.setHours(0, 0, 0, 0);
		const utcVal = date.getTime();

		if (utcVal < earliestDate) { return false; } // Ignore dates prior to 20/11/1998

		let dateCount: IDateCount | undefined = dateFrequencies.get(utcVal);
		if (dateCount) {
			// update existing entry
			const n = dateCount?.totalEvents;
			dateCount.totalEvents = n + 1;
		} else {
			// add new entry
			dateCount = { totalEvents: 1 };
			dateFrequencies.set(utcVal, dateCount);
		}

		dateCount[event.from] ? dateCount[event.from]++ : dateCount[event.from] = 1;
		dateCount[event.to] ? dateCount[event.to]++ : dateCount[event.to] = 1;
	});

	return dateFrequencies;
}

function createDygraphData(sortedDates: number[]): [Date, number][] {
	let data: [Date, number][] = [];
	sortedDates.forEach(key => {
		const dateCount: IDateCount | undefined = dateFrequencies.get(key);
		if (dateCount) {
			data.push([new Date(+key), dateCount.totalEvents]);
		}
	});

	return data;
}

function highlightNeighbouringNodes(node: cytoscape.NodeSingular): void {
	
	cs.batch(function() {
		cs.nodes().removeClass(selectedNodePrimaryClass + ' ' + selectedNodeSecondaryClass);
		node.neighborhood().addClass(selectedNodeSecondaryClass);
		node.addClass(selectedNodePrimaryClass);
	});
}

function highlightNeighbouringEdges(node: cytoscape.NodeSingular): void {
	cs.batch(function() {
		cs.edges().removeClass(selectedEdgeClass);
		let edges: cytoscape.EdgeCollection = node.connectedEdges();
		edges.addClass(selectedEdgeClass);
	})
}

function highlightEndNodes(edge: cytoscape.EdgeSingular): void {
	// Given an edge, highlight the nodes on both ends

	cs.batch(function() {
		let nodeSource: cytoscape.NodeSingular = cs.getElementById(edge.data('source'));
		let nodeTarget: cytoscape.NodeSingular = cs.getElementById(edge.data('target'));
		if (nodeSource && nodeTarget) {
			cs.nodes().removeClass(selectedNodePrimaryClass + ' ' + selectedNodeSecondaryClass);
			nodeSource.addClass(selectedNodeSecondaryClass);
			nodeTarget.addClass(selectedNodeSecondaryClass);
		}
	});
}

function highlightSiblingEdges(edge: cytoscape.EdgeSingular): void {
	
	let edges: cytoscape.EdgeCollection = getSiblingEdges(edge);
	cs.batch(function() {
		cs.edges().removeClass(selectedEdgeClass);
		edges.addClass(selectedEdgeClass);
	});
}

function deselectAll(): void {
	cs.batch(function() { // Probably don't have to batch here..
		cs.nodes().removeClass([selectedNodePrimaryClass, selectedNodeSecondaryClass]);
		cs.edges().removeClass(selectedEdgeClass);
	});

	clearSearchResults();
	clearElementInfo();
}

// #endregion


// #region inputEvents

export function toggleMenuPanel(open?: boolean): void {
	const menuPanel = document.getElementById(menuPanelId);
	const computedStyle = window.getComputedStyle(menuPanel);
	const transformValue = computedStyle.getPropertyValue('transform');
	const isOpen = transformValue === 'matrix(1, 0, 0, 1, 0, 0)';

	if (open === undefined) {
		// Toggle the menu panel if the 'open' parameter is not provided
		menuPanel.style.transform = isOpen ? 'translateY(-100%)' : 'translateY(0%)';
	} else {
		// Set the menu panel to the specified state if the 'open' parameter is provided
		menuPanel.style.transform = open ? 'translateY(0%)' : 'translateY(-100%)';
	}
}

function closeAllPanels(): void {
	toggleMenuPanel(false);
	toggleInfoPanel(false);
}

export function toggleInfoPanel(open?: boolean): void {
	const infoPanel = document.getElementById(infoPanelId);
	const computedStyle = window.getComputedStyle(infoPanel);
	const transformValue = computedStyle.getPropertyValue('transform');
	const isOpen = transformValue === 'matrix(1, 0, 0, 1, 0, 0)';

	// 94 because it should remain partially visible
	if (open === undefined) {
		// Toggle the menu panel if the 'open' parameter is not provided
		infoPanel.style.transform = isOpen ? 'translateX(94%)' : 'translateX(0%)';
		updateInfoToggleArrow(isOpen);
	} else {
		// Set the menu panel to the specified state if the 'open' parameter is provided
		infoPanel.style.transform = open ? 'translateX(0%)' : 'translateX(94%)';
		updateInfoToggleArrow(open);  
	}
}

function updateInfoToggleArrow(isOpen: boolean): void {
	// Rotate the '>'
	const infoArrow = document.getElementById(infoPanelToggleArrowId);
	infoArrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
}

export function populateSearchResults(results: string[]): void {
	const searchResultsList: HTMLElement = document.getElementById(searchPanelId);
	if (!searchResultsList) { return; }

	clearSearchResults();

	// Populate with new results
	results.forEach(result => {
		const li = document.createElement('li');
		li.textContent = result;
		searchResultsList.appendChild(li);
	});
}

export function clearSearchResults(): void {
	const searchResultsList: HTMLElement = document.getElementById(searchPanelId);
	if (searchResultsList) {
		searchResultsList.innerHTML = '';
	}
}

function onNodeHover(event: any, element: HTMLElement, timeout: any): void {
	let node: cytoscape.NodeSingular = event.target;
	if (element) {
		clearTimeout(timeout);

		timeout = setTimeout(function() {
			let name: string = node.data('name');
			let sent: string = node.data('rank');
			let recieved: string = (node.connectedEdges().length - +sent).toString();
			let isNER: boolean = isNERType(node.data('type'));
			
			element.innerHTML = `Node ID: ${node.id()}<br>Name: ${name}<br>Sent: ${sent}<br>Recieved: ${recieved}`;
			element.style.display = 'block';
			element.style.left = event.originalEvent.clientX + tooltipOffsetX + 'px';
			element.style.top = event.originalEvent.clientY + tooltipOffsetY + 'px';
			element.style.color = isNER ? 'red' : 'black';
		}, tooltipTimoutInMsecs);
	}
}

function onEdgeHover(event: any, element: HTMLElement, timeout: any): void {
	let edge = event.target;
	if (element) {
		clearTimeout(timeout);

		timeout = setTimeout(function() {
			let date: string = formatDateWithTime(edge.data('datetime'));
			let from: string = edge.data('from');
			let to: string = edge.data('to');
			let subject: string = edge.data('subject');
			
			element.innerHTML = `Event ID: ${edge.id()}<br>Date: ${date}<br>From: ${from}<br>To: ${to}<br>Subject: ${subject}`;
			element.style.display = 'block';
			element.style.left = event.originalEvent.clientX + tooltipOffsetX + 'px';
			element.style.top = event.originalEvent.clientY + tooltipOffsetY + 'px';
		}, tooltipTimoutInMsecs);
	}
}

function onEndHover(element: HTMLElement, timeout: any): void {
	if (element) {
		clearTimeout(timeout);
		element.style.display = 'none';
	}
}

function getNodeInfoFormattedStr(node: cytoscape.NodeSingular): string {
	if (!node) { return ''; }

	let id: string = node.data('id');
	let name: string = node.data('name');
	let degree: string = node.connectedEdges().length.toString();

	let str: string = 'Id: ' + id + ', ' + name + ', Degree: ' + degree;
	console.log(str);

	return str;
}

function onNodeClick(node: cytoscape.NodeSingular): void {
	toggleMenuPanel(false);
	toggleInfoPanel(true);
	populateSearchResults(getFormattedNodeEdges(node));

	// Update selection
	highlightNeighbouringNodes(node);
	highlightNeighbouringEdges(node);

	// Update selected element info
	let nodeInfoElement = document.getElementById(selectedElementInfoId);
	if (nodeInfoElement) {
		nodeInfoElement.textContent = getNodeInfoFormattedStr(node);
	}
}

function onBackgroundClick(event: any): void {
	if (event.target !== cs) { return; } // Ensure background was clicked

	toggleMenuPanel(false);
	deselectAll();
}

function onEdgeClick(edge: cytoscape.EdgeSingular): void {
	toggleMenuPanel(false);
	toggleInfoPanel(true);
	populateSearchResults(getFormattedEdgeSiblings(edge));

	// Update selection
	highlightEndNodes(edge);
	highlightSiblingEdges(edge);

	// Update selected element info
	let edgeInfoElement = document.getElementById(selectedElementInfoId);
	if (edgeInfoElement) {
		edgeInfoElement.textContent = getEdgeInfoFormattedStr(edge);
	}
};

function getEdgeInfoFormattedStr(edge: cytoscape.EdgeSingular): string {
	if (!edge) { return; }

	let id: string = edge.data('id');
	let date: string = formatDateWithTime(edge.data('datetime'));
	let subject: string = edge.data('subject');
	let str: string = 'Id: ' + id + ', Date: ' + date + ', Subject: ' + subject;
	// console.log(str);
	return str;
}

// #endregion


// #region Init

async function initializeCytoscapeGraph(): Promise<void> {
	if (DEBUG_Calls) { console.log('initializing graph...'); }

	cs = cytoscape({
		container: document.getElementById(GraphDivId),
		elements: [],
		wheelSensitivity: 0.1, // default is 1 which zooms too far with each step
		minZoom: 0.1,
		maxZoom: 4,

		// Performance options
		pixelRatio: 1,
		hideEdgesOnViewport: true,
		hideLabelsOnViewport: true,
	});

	let elements: cytoscape.ElementDefinition[] = [];

	// Load the nodes and apply layout
	cs.batch(async function () {

		await loadEnronData();

		cs.style(getSelectors());
		cs.add(elements);

		await filterGraph();

		//runLayout_Grid();
		runLayout_Cose();
		
	}); // End batch

	//console.log('max rank:', maxNodeRank); // TODO: Update slider max value with this

}

async function initializeDygraphChart(): Promise<void> {
	if (DEBUG_Calls) { console.log('initializing Timeline...'); }
	
	let latestDate: number = 0;

	// Establish latest date
	enronEvents.forEach(event => {
		const utcVal = Date.parse(event.date);
		if (!isNaN(utcVal) && utcVal > latestDate) {
			latestDate = utcVal;
		}
	});

	dateFrequencies.clear();
	dateFrequencies = getTimebarDateFrequencies();
	const sortedKeys = Array.from(dateFrequencies.keys()).sort((a, b) => +a - +b);
	let data: [Date, number][] = createDygraphData(sortedKeys);
	
	// console.log('earliest date =', earliestDate);
	// console.log('latest date = ', latestDate);
	
	if (data.length === 0) {
		console.log("No data loaded. Is degree filter value (", getDegree(), ") too high?");
		return;
	}

	dg = new Dygraph(document.getElementById(TimebarDivId), data, {
		labels: ['Date', 'Events'],
		showRangeSelector: true,
		plotter: barChartPlotterFn,
		drawCallback: drawCallbackFn,
		rangeSelectorHeight: 30,
		rangeSelectorPlotFillColor: 'MediumSlateBlue',
		rangeSelectorPlotFillGradientColor: 'rgba(123, 104, 238, 1)',
		colorValue: 0.9,
		fillAlpha: 0.4,
		drawPoints: true,
		dateWindow: [earliestDate, latestDate], //https://dygraphs.com/options.html#:~:text=dateWindow%20%23,If%20the%20data
		//strokeWidth: 0.0
    });
}

function initInteractions() {

	let tooltipTimeout: any;
	const nodetip: HTMLElement | null = document.getElementById('nodetip');

	// Nodes:

	cs.on('mouseover', 'node', function(event) {
		onNodeHover(event, nodetip, tooltipTimeout);
	});

	cs.on('mouseout', 'node', function() {
		onEndHover(nodetip, tooltipTimeout);
	});

	// Single click on node
	cs.on('click', 'node', function() {
		onNodeClick(this);
	});

	// Single click on background
	cs.on('click', function(event) {
		onBackgroundClick(event);
		onEndHover(nodetip, tooltipTimeout);
	});

	// Double click on node
	cs.on('dblclick', 'node', function() {
		toggleMenuPanel(false);
		console.log('dblclick'); // No Op
	});

	// Double click on background
	cs.on('dblclick', function(e) {
		if (e.target !== cs) { return; } // Ensure background was clicked

		closeAllPanels();
		cs.batch(function() {
			cs.fit(cs.nodes(), 100);
			cs.center(cs.nodes());
			deselectAll();
		});
	});

	// Edges:

	cs.on('mouseover', 'edge', function(event) {
		onEdgeHover(event, nodetip, tooltipTimeout);
	});

	cs.on('mouseout', 'edge', function() {
		onEndHover(nodetip, tooltipTimeout);
	});

	cs.on('click', 'edge', function() {
		onEdgeClick(this);
	});
}

// #endregion


// #region Entry

export async function init(): Promise<void> {
	
	// Immediately close the menu & wait
	toggleMenuPanel(false); setTimeout(() => {}, 400); // Needs to match/exceed index.html style #west transform property
	
	// Disable the button to prevent accidently pressing it again
	const btn: HTMLButtonElement = document.getElementById('loadDataBtn') as HTMLButtonElement; btn.disabled = true;

	// Todo: show spinner while loading

	await fetchEnronData();
	initializeCytoscapeGraph();
	hideSplash(); // Hide splash once graph is visible

	initializeDygraphChart();
	initInteractions();

	cs.fit();
	cs.center(cs.nodes());
}

// #endregion