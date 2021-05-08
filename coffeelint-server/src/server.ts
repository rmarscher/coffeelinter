'use strict';

import * as coffeeLint from 'coffeelint';
import * as fs from 'fs';
import * as path from 'path';
import configFinder from 'coffeelint/lib/configfinder';

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceFolder } from 'vscode-languageserver-protocol';

interface ICoffeeLintSettings {
	enable: boolean;
	defaultRules: object;
}

interface IWorkspaceFolderCoffeeLintRules {
	uri: string;
	rules: object;
}

interface ICoffeeLintExtension {
	settings: ICoffeeLintSettings;
	workspaceFolders: IWorkspaceFolderCoffeeLintRules[];
}


// function mergeConfig(currentConfig: object, workspaceConfig: object) {
// 	let newConfig = Object.assign({}, workspaceConfig);
// 	Object.assign(newConfig, currentConfig);
// 	Object.assign(currentConfig, newConfig);
// }


let coffeeLintExtension: ICoffeeLintExtension = {
	settings: {
		enable: true,
		defaultRules: {}
	},
	workspaceFolders: []
};


// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
console.log("hello from coffee lang server");

// Create a simple text document manager.
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

let workspaceFolderCoffeeLintRules: object[] = []

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;
	console.log("coffee lang server onInitialize");

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
			  resolveProvider: true
			}
	  	}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
	  	};
	}
	return result;
});

function addWorkspaceFolderRules(folder: WorkspaceFolder) {
	let coffeeLintConfigFile = path.join(folder.uri, 'coffeelint.json');
	if (!fs.existsSync(coffeeLintConfigFile)) {
		return;
	}

	let rules: object;
	try {
		rules = configFinder.getConfig(coffeeLintConfigFile);
	} catch (error) {
		console.log("Invalid coffeelint config for " + folder.uri);
		return;
	}

	coffeeLintExtension.workspaceFolders.push({
		uri: folder.uri,
		rules
	});
}

connection.onInitialized(async () => {
	console.log("coffee lang server initialized");
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(async _event => {
			// connection.console.log('Workspace folder change event received.');
			const folders = await connection.workspace.getWorkspaceFolders();
			coffeeLintExtension.workspaceFolders = [];
			folders.forEach(addWorkspaceFolderRules);
		});
	}
});

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings = (): ICoffeeLintSettings => ({
	enable: true, defaultRules: {}
});
let globalSettings: ICoffeeLintSettings = defaultSettings();

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ICoffeeLintSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = (
			(change.settings.coffeelinter || defaultSettings)
		) as ICoffeeLintSettings;
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ICoffeeLintSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'coffeelinter'
		});
		result.then((settings) => {
			for (let i = 0, t = coffeeLintExtension.workspaceFolders.length; i < i; i++) {
				const folder = coffeeLintExtension.workspaceFolders[i];
				if (resource.startsWith(folder.uri)) {
					settings.defaultRules = folder.rules;
					return settings;
				}
			}
			return settings;
		})
		documentSettings.set(resource, Promise.resolve(result));
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	console.log('getting document settings')
	let settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	console.log('getting document text')
	let text = textDocument.getText();
	let literate = textDocument.uri.endsWith('.litcoffee');
	console.log('coffee linting')
	let issues = coffeeLint.lint(text, settings.defaultRules, literate);
	console.log(issues)
	let diagnostics: Diagnostic[] = [];

	for (let issue of issues) {
		let severity: DiagnosticSeverity;

		if (issue.level === "warning" || issue.level === "warn") {
			severity = DiagnosticSeverity.Warning;
		}
		else if (issue.level === "error") {
			severity = DiagnosticSeverity.Error;
		}
		else if (issue.level === "hint") {
			severity = DiagnosticSeverity.Hint;
		}
		else {
			severity = DiagnosticSeverity.Information;
		}

		let diagnostic: Diagnostic = {
			severity,
			range: {
				start: { line: issue.lineNumber - 1, character: 0 },
				end: { line: issue.lineNumber - 1, character: Number.MAX_VALUE } // end of line
			},
			message: issue.message,
			source: "CoffeeLint"
		};
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VS Code.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  }

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VS Code
	connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	// The pass parameter contains the position of the text document in
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.
	return [
		{
			label: 'TypeScript',
			kind: CompletionItemKind.Text,
			data: 1
		},
		{
			label: 'JavaScript',
			kind: CompletionItemKind.Text,
			data: 2
		}
	];
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = 'TypeScript details';
		item.documentation = 'TypeScript documentation';
	} else if (item.data === 2) {
		item.detail = 'JavaScript details';
		item.documentation = 'JavaScript documentation';
	}
	return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
