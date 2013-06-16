

var GitGraphViewModel = function(repoPath) {
	var self = this;
	this.nodes = ko.observable([]);
	this.refs = ko.observableArray();
	this.daySeparators = ko.observable();
	this.nodesById = {};
	this.refsByRefName = {};
	this.repoPath = repoPath;
	this.activeBranch = ko.observable();
	this.HEAD = ko.observable();
	this.hoverGraphAction = ko.observable();
	this.draggingRef = ko.observable();
	this.hasRemotes = ko.observable(false);
	this.showDropTargets = ko.computed(function() {
		return !!self.draggingRef();
	});
	this.refDropActionsWorking = ko.observable(false);
	this.showRefDropActions = ko.computed(function() {
		return self.showDropTargets() || self.refDropActionsWorking();
	});
}

GitGraphViewModel.prototype.dropPushRef = function(ref) {
	var self = this;
	this.refDropActionsWorking(false);
	viewModel.dialog(new PushDialogViewModel({ repoPath: this.repoPath, localBranch: ref.displayName, remoteBranch: ref.displayName }));
}
GitGraphViewModel.prototype.dropCheckoutRef = function(ref) {
	var self = this;
	this.refDropActionsWorking(true);
	api.query('POST', '/checkout', { path: this.repoPath, name: ref.displayName }, function(err) {
		self.refDropActionsWorking(false);
	});
}
GitGraphViewModel.prototype.dropDeleteRef = function(ref) {
	var self = this;
	this.refDropActionsWorking(true);
	var url = ref.isTag ? '/tags' : '/branches';
	api.query('DELETE', url, { path: this.repoPath, name: ref.displayName, remote: ref.isRemote }, function(err) {
		self.refDropActionsWorking(false);
	});
}

GitGraphViewModel.prototype.loadNodesFromApi = function() {
	var self = this;
	api.query('GET', '/log', { path: this.repoPath, limit: GitGraphViewModel.maxNNodes }, function(err, logEntries) {
		if (err) return;
		self.setNodesFromLog(logEntries);
	});
}

GitGraphViewModel.prototype.setNodesFromLog = function(nodes) {
	var self = this;
	var nodeVMs = [];
	nodes.forEach(function(node) {
		node.graph = self;
		var nodeViewModel = self.nodesById[node.sha1] || new NodeViewModel(node);
		nodeVMs.push(nodeViewModel);
		self.nodesById[node.sha1] = nodeViewModel;
		if (node.refs) {
			var refVMs = node.refs.map(function(ref) {
				var refViewModel = self.refsByRefName[ref];
				if (!refViewModel) {
					var refViewModel = self.refsByRefName[ref] = new RefViewModel({ name: ref, graph: self });
					self.refs.push(refViewModel);
				}
				refViewModel.node(nodeViewModel);
				return refViewModel;
			});
			refVMs.sort(function(a, b) {
				if (a.isLocalBranch && !b.isLocalBranch) return -1;
				if (!a.isLocalBranch && b.isLocalBranch) return 1;
				return a.displayName < b.displayName ? -1 : 1;
			});
			nodeViewModel.refs(refVMs);
		}
	});
	this.HEAD(GitGraphViewModel.getHEAD(nodeVMs));
	this.setNodes(nodeVMs);
}

GitGraphViewModel.getHEAD = function(nodes) {
	return _.find(nodes, function(node) { return _.find(node.refs(), function(r) { return r.isLocalHEAD; }); });
}

GitGraphViewModel.traverseNodeParents = function(node, nodesById, callback) {
	if (node.index() >= GitGraphViewModel.maxNNodes) return;
	callback(node);
	node.parents.forEach(function(parentId) {
		var parent = nodesById[parentId];
		if (parent)
			GitGraphViewModel.traverseNodeParents(parent, nodesById, callback);
	});
}

GitGraphViewModel.markNodesIdealogicalBranches = function(HEAD, nodes, nodesById) {
	var recursivelyMarkBranch = function(e, idealogicalBranch) {
		GitGraphViewModel.traverseNodeParents(e, nodesById, function(node) {
			node.idealogicalBranch = idealogicalBranch;
		});
	}
	var getIdeologicalBranch = function(e) {
		return _.find(e.refs(), function(ref) { return ref.isBranch; });
	}
	var master;
	nodes.forEach(function(e) {
		var i = 0;
		var idealogicalBranch = getIdeologicalBranch(e);
		if (!idealogicalBranch) return;
		if (idealogicalBranch.name == 'refs/heads/master') master = e;
		recursivelyMarkBranch(e, idealogicalBranch);
	});
	if (master) {
		recursivelyMarkBranch(master, master.idealogicalBranch);
	}
}

GitGraphViewModel.randomColor = function() {
	var randomHex = function() {
		var r = Math.floor(Math.random() * 256).toString(16);
		if (r.length == 1) r = '0' + r;
		return r;
	}
	return '#' + randomHex() + randomHex() + randomHex();
}

GitGraphViewModel.maxNNodes = 100;

GitGraphViewModel.prototype.setNodes = function(nodes) {
	var daySeparators = [];
	nodes.sort(function(a, b) { return b.commitTime.unix() - a.commitTime.unix(); });
	nodes.forEach(function(node, i) { node.index(i); });
	nodes = nodes.slice(0, GitGraphViewModel.maxNNodes);

	var HEAD = this.HEAD();
	if (!HEAD) return;
	GitGraphViewModel.markNodesIdealogicalBranches(HEAD, nodes, this.nodesById);

	// Make sure refs know their "remote"
	for(var refName in this.refsByRefName) {
		var ref = this.refsByRefName[refName];
		if (ref.isLocalBranch) {
			var remote = this.refsByRefName['refs/remotes/origin/' + ref.displayName];
			if (remote) {
				ref.remoteRef(remote);
				remote.localRef(ref);
				remote.color = ref.color;
			}
		}
	}

	var updateTimeStamp = moment().valueOf();

	// Mark timestamps
	GitGraphViewModel.traverseNodeParents(HEAD, this.nodesById, function(node) {
		node.ancestorOfHEADTimeStamp = updateTimeStamp;
	});

	// Filter out nodes which doesn't have a branch (staging and orphaned nodes)
	nodes = nodes.filter(function(node) { return !!node.idealogicalBranch || node.ancestorOfHEADTimeStamp == updateTimeStamp; })

	//var concurrentBranches = { };

	var branchSlots = [];
	var y = 30; // Leave room for the "commit node" (see logrednerer.js)

	// Then iterate from the bottom to fix the orders of the branches
	for (var i = nodes.length - 1; i >= 0; i--) {
		var node = nodes[i];
		if (node.ancestorOfHEADTimeStamp == updateTimeStamp) continue;
		var idealogicalBranch = node.idealogicalBranch;

		// First occurence of the branch, find an empty slot for the branch
		if (idealogicalBranch.lastSlottedTimeStamp != updateTimeStamp) {
			idealogicalBranch.lastSlottedTimeStamp = updateTimeStamp;
			var slot = 0;
			for(;slot < branchSlots.length; slot++)
				if (branchSlots[slot] === undefined) break;
			if (slot == branchSlots.length) {
				branchSlots.push(idealogicalBranch);
				slot = branchSlots.length - 1;
			}
			idealogicalBranch.branchOrder = slot;
			branchSlots[slot] = slot;
		}

		node.branchOrder = idealogicalBranch.branchOrder;

		// Free branch slots when we reach the end of a branch
		/*if (node == idealogicalBranch.node()) {
			branchSlots[idealogicalBranch.branchOrder] = undefined;
		}*/
	}

	var prevNode;
	nodes.forEach(function(node) {
		if (node.ancestorOfHEADTimeStamp == updateTimeStamp) {
			if (!prevNode)
				y += 90;
			else if (prevNode.ancestorOfHEADTimeStamp == updateTimeStamp)
				y += 120;
			else
				y += 60;
			node.x(30);
			node.radius(30);
			node.logBoxVisible(true);
		} else {
			y += 60;
			node.x(30 + 90 * (branchSlots.length - node.branchOrder));
			node.radius(15);
			node.logBoxVisible(false);
		}
		node.y(y);

		if (prevNode && prevNode.commitTime.dayOfYear() != node.commitTime.dayOfYear()) {
			daySeparators.push({ x: 0, y: node.y(), date: node.commitTime.format('ll') });
		}

		prevNode = node;
	});

	this.nodes(nodes);
	this.daySeparators(daySeparators);
}

NodeViewModel = function(args) {
	var self = this;
	this.graph = args.graph;
	this.x = ko.observable(0);
	this.y = ko.observable(0);
	this.position = ko.computed(function() {
		return new Vector2(self.x(), self.y());
	});
	this.radius = ko.observable(30);
	this.boxDisplayX = ko.computed(function() {
		return self.x();
	});
	this.boxDisplayY = ko.computed(function() {
		return self.y();
	});
	this.commitTime = moment(args.commitDate);
	this.authorTime = moment(args.authorDate);
	this.parents = args.parents || [];
	var message = args.message.split('\n');
	this.message = args.message;
	this.title = message[0];
	this.body = message.slice(2).join('\n');
	this.sha1 = args.sha1;
	this.authorDate = ko.observable(moment(args.authorDate).fromNow());
	setInterval(function() { self.authorDate(moment(args.authorDate).fromNow()); }, 1000 * 60);
	this.authorName = args.authorName;
	this.authorEmail = args.authorEmail;
	this.index = ko.observable();
	this.logBoxVisible = ko.observable(true);
	this.refs = ko.observable([]);
	this.branches = ko.computed(function() {
		return self.refs().filter(function(r) { return r.isBranch; });
	});
	this.tags = ko.computed(function() {
		return self.refs().filter(function(r) { return r.isTag; });
	});
	this.newBranchName = ko.observable();
	this.newBranchNameHasFocus = ko.observable(true);
	this.newBranchNameHasFocus.subscribe(function(newValue) {
		if (!newValue) self.branchingFormVisible(false);
	})
	this.branchingFormVisible = ko.observable(false);
	this.showDropTargets = ko.computed(function() {
		return self.graph.showDropTargets();
	});
}
NodeViewModel.prototype.showBranchingForm = function() {
	this.branchingFormVisible(true);
	this.newBranchNameHasFocus(true);
}
NodeViewModel.prototype.createBranch = function() {
	api.query('POST', '/branches', { path: this.graph.repoPath, name: this.newBranchName(), startPoint: this.sha1 });
	this.branchingFormVisible(false);
	this.newBranchName('');
}
NodeViewModel.prototype.createTag = function() {
	api.query('POST', '/tags', { path: this.graph.repoPath, name: this.newBranchName(), startPoint: this.sha1 });
	this.branchingFormVisible(false);
	this.newBranchName('');
}
NodeViewModel.prototype.dropMoveRef = function(ref) {
	if (ref.current())
		api.query('POST', '/reset', { path: this.graph.repoPath, to: this.sha1 });
	else if (ref.isTag)
		api.query('POST', '/tags', { path: this.graph.repoPath, name: ref.displayName, startPoint: this.sha1, force: true });
	else
		api.query('POST', '/branches', { path: this.graph.repoPath, name: ref.displayName, startPoint: this.sha1, force: true });
}
NodeViewModel.prototype.isAncestor = function(node) {
	if (this.index() >= GitGraphViewModel.maxNNodes) return false;
	if (node == this) return true;
	for (var v in this.parents) {
		var n = this.graph.nodesById[this.parents[v]];
		if (n && n.isAncestor(node)) return true;
	}
	return false;
}
NodeViewModel.prototype.getPathToCommonAncestor = function(node) {
	var path = [];
	var thisNode = this;
	while (!node.isAncestor(thisNode)) {
		path.push(thisNode);
		thisNode = this.graph.nodesById[thisNode.parents[0]];
	}
	path.push(thisNode);
	return path;
}

var RefViewModel = function(args) {
	var self = this;
	this.node = ko.observable();
	this.boxDisplayX = ko.computed(function() {
		if (!self.node()) return 0;
		return self.node().x();
	});
	this.boxDisplayY = ko.computed(function() {
		if (!self.node()) return 0;
		return self.node().y();
	});
	this.name = args.name;
	this.displayName = this.name;
	this.isLocalTag = this.name.indexOf('tag: refs/tags/') == 0;
	this.isRemoteTag = false; // TODO
	this.isTag = this.isLocalTag || this.isRemoteTag;
	this.isLocalHEAD = this.name == 'HEAD';
	this.isRemoteHEAD = this.name == 'refs/remotes/origin/HEAD';
	this.isLocalBranch = this.name.indexOf('refs/heads/') == 0;
	this.isRemoteBranch = this.name.indexOf('refs/remotes/origin/') == 0 && !this.isRemoteHEAD;
	this.isHEAD = this.isLocalHEAD || this.isRemoteHEAD;
	this.isBranch = this.isLocalBranch || this.isRemoteBranch;
	this.isRemote = this.isRemoteBranch || this.isRemoteTag;
	this.isLocal = this.isLocalBranch || this.isLocalTag;
	if (this.isLocalBranch) this.displayName = this.name.slice('refs/heads/'.length);
	if (this.isRemoteBranch) this.displayName = this.name.slice('refs/remotes/origin/'.length);
	if (this.isTag) this.displayName = this.name.slice('tag: refs/tags/'.length);
	this.show = true;
	this.graph = args.graph;
	this.remoteRef = ko.observable();
	this.localRef = ko.observable();
	this.current = ko.computed(function() {
		return self.isLocalBranch && self.graph.activeBranch() == self.displayName;
	});
	this.canBePushed = ko.computed(function() {
		return self.isLocal && self.graph.hasRemotes();
	});
	this.color = GitGraphViewModel.randomColor();
	this.remoteIsAncestor = ko.computed(function() {
		if (!self.remoteRef()) return false;
		return self.node().isAncestor(self.remoteRef().node());
	});
	this.remoteIsOffspring = ko.computed(function() {
		if (!self.remoteRef()) return false;
		return self.remoteRef().node().isAncestor(self.node());
	});
	this.graphActions = [
		new PushGraphAction(this.graph, this),
		new ResetGraphAction(this.graph, this),
		new RebaseGraphAction(this.graph, this),
		new PullGraphAction(this.graph, this)
	];
}
RefViewModel.prototype.dragStart = function() {
	this.graph.draggingRef(this);
}
RefViewModel.prototype.dragEnd = function() {
	this.graph.draggingRef(null);
}


var GraphAction = function(graph) {
	this.graph = graph;
}
GraphAction.prototype.mouseover = function() {
	this.graph.hoverGraphAction(this);
}
GraphAction.prototype.mouseout = function() {
	this.graph.hoverGraphAction(null);
}

var PushGraphAction = function(graph, ref) {
	var self = this;
	GraphAction.call(this, graph);
	this.ref = ref;
	this.visible = ko.computed(function() {
		if (self.ref.remoteRef())
			return self.ref.remoteRef().node() != self.ref.node() && self.ref.remoteIsAncestor();
		else if (self.graph.hasRemotes()) return true;
	});
}
inherits(PushGraphAction, GraphAction);
PushGraphAction.prototype.style = 'push';
PushGraphAction.prototype.icon = 'P';
PushGraphAction.prototype.tooltip = 'Push to remote';
PushGraphAction.prototype.perform = function() {
	this.graph.hoverGraphAction(null);
	viewModel.dialog(new PushDialogViewModel({ repoPath: this.graph.repoPath }));
}


var ResetGraphAction = function(graph, ref) {
	var self = this;
	GraphAction.call(this, graph);
	this.ref = ref;
	this.visible = ko.computed(function() {
		return self.ref.remoteRef() && self.ref.remoteRef().node() != self.ref.node() && !self.ref.remoteIsOffspring();
	});
}
inherits(ResetGraphAction, GraphAction);
ResetGraphAction.prototype.style = 'reset';
ResetGraphAction.prototype.icon = 'R';
ResetGraphAction.prototype.tooltip = 'Reset to remote';
ResetGraphAction.prototype.perform = function() {
	this.graph.hoverGraphAction(null);
	api.query('POST', '/reset', { path: this.graph.repoPath, to: this.ref.remoteRef().name });
}


var RebaseGraphAction = function(graph, ref) {
	var self = this;
	GraphAction.call(this, graph);
	this.ref = ref;
	this.visible = ko.computed(function() {
		return self.ref.remoteRef() && self.ref.remoteRef().node() != self.ref.node() && !self.ref.remoteIsAncestor() && !self.ref.remoteIsOffspring();
	});
}
inherits(RebaseGraphAction, GraphAction);
RebaseGraphAction.prototype.style = 'rebase';
RebaseGraphAction.prototype.icon = 'R';
RebaseGraphAction.prototype.tooltip = 'Rebase on remote';
RebaseGraphAction.prototype.perform = function() {
	this.graph.hoverGraphAction(null);
	api.query('POST', '/rebase', { path: this.graph.repoPath, onto: this.ref.remoteRef().name });
}


var PullGraphAction = function(graph, ref) {
	var self = this;
	GraphAction.call(this, graph);
	this.ref = ref;
	this.visible = ko.computed(function() {
		return self.ref.remoteRef() && self.ref.remoteRef().node() != self.ref.node() && self.ref.remoteIsOffspring();
	});
}
inherits(PullGraphAction, GraphAction);
PullGraphAction.prototype.style = 'pull';
PullGraphAction.prototype.icon = 'P';
PullGraphAction.prototype.tooltip = 'Pull to remote';
PullGraphAction.prototype.perform = function() {
	this.graph.hoverGraphAction(null);
	api.query('POST', '/reset', { path: this.graph.repoPath, to: this.ref.remoteRef().name });
}