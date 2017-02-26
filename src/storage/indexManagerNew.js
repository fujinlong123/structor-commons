/*
 * Copyright 2015 Alexander Pustovalov
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import {forOwn, isObject, isEmpty, clone, pick} from 'lodash';
import * as config from '../configuration.js';
import {readFile, readJson, readDirectoryFlat, isExisting} from '../commons/fileManager.js';
import {traverse, traverseModelWithResult, parse, generate, repairPath} from '../commons/utils.js';
import {getImportsObject, findExportsNode, getExportObject} from '../commons/astUtils.js';

/*

componentsTree = {
	htmlComponents: {
		[name]: {
			name,
			defaults: []
		}
	},
	components: {
		[name]: {
			name,
			importPath,
			absolutePath,
			isContainer,
 			isLibMember,
			defaults: []
		}
	},
	modules: {
		[name]: {
			name,
			importPath,
			absolutePath,
			components: {
				[name]: {
					name,
					importPath,
					absolutePath,
					isContainer,
					isLibMember,
					defaults: []
				}
			}
		}
	}
}

 */

function assignImport(importDef, moduleImportPath) {
	const dirPath = config.appDirPath();
	let componentDef;
	if (importDef) {
		const {source, member} = importDef;
		let sourceParts;
		if (source && source.length > 0) {
			sourceParts = source.split('/');
			if (sourceParts.length > 0) {
				componentDef = {};
				if (sourceParts[0] === '.' && sourceParts.length > 1) {
					if (moduleImportPath) {
						componentDef.importPath = path.join(moduleImportPath, source.substr(2));
						componentDef.absolutePath = path.join(dirPath, componentDef.importPath);
					} else {
						componentDef.importPath = source.substr(2);
						componentDef.absolutePath = path.join(dirPath, componentDef.importPath);
					}
					if (sourceParts[1] === 'components') {
						componentDef.isComponent = true;
					} else if (sourceParts[1] === 'containers') {
						componentDef.isContainer = true;

					} else if (sourceParts[1] === 'modules') {
						componentDef.isModule = true;
					}
				} else {
					if (moduleImportPath) {
						componentDef.importPath = path.join(moduleImportPath, source);
						componentDef.absolutePath = path.join(dirPath, componentDef.importPath);
					} else {
						componentDef.importPath = source;
						componentDef.absolutePath = path.join(dirPath, componentDef.importPath);
					}
					if (sourceParts[0] === 'components') {
						componentDef.isComponent = true;
					} else if (sourceParts[0] === 'containers') {
						componentDef.isContainer = true;
					} else if (sourceParts[0] === 'modules') {
						componentDef.isModule = true;
					} else if (!sourceParts[0].startsWith('.')) {
						componentDef.isLibMember = true;
						componentDef.importPath = source;
						delete componentDef.absolutePath;
					}
				}
			}
		}
	}
	return componentDef;
}

function reevaluateImports(importDefs) {
	forOwn(importDefs, (value, prop) => {
		value.source = repairPath(value.source);
	});
	return importDefs;
}

function getIndexRefs(filePath, moduleDef = {}) {
	let componentTree = {
		components: {},
		modules: {}
	};
	return readFile(filePath)
		.then(fileData => {
			const ast = parse(fileData);
			// console.log(JSON.stringify(ast, null, 4));
			let imports = getImportsObject(ast);
			// console.log(JSON.stringify(imports, null, 4));
			let astNode = findExportsNode(ast);
			// console.log(JSON.stringify(astNode, null, 4));
			let exportObject = getExportObject(astNode);
			// console.log(JSON.stringify(exportObject, null, 4));
			imports = reevaluateImports(imports);
			forOwn(exportObject, (value, prop) => {
				if (!isObject(value)) {
					let importDef = imports[value];
					if (importDef) {
						let componentDef = assignImport(importDef, moduleDef.importPath);
						if (componentDef) {
							let treeDef = pick(componentDef, ['importPath', 'absolutePath']);
							treeDef.name = prop;
							if (componentDef.isComponent) {
								componentTree.components[prop] = treeDef;
							} else if (componentDef.isContainer) {
								componentTree.components[prop] = treeDef;
								treeDef.isContainer = true;
							} else if (componentDef.isModule) {
								componentTree.modules[prop] = treeDef;
							} else if (componentDef.isLibMember) {
								componentTree.components[prop] = treeDef;
								treeDef.isLibMember = true;
							} else {
								console.error('Invalid component definition: ', prop, filePath);
							}
						} else {
							console.error('Components index includes wrong reference definition: ', prop, filePath);
						}
					} else {
						console.error('Components index includes reference without import: ', prop, filePath);
					}
				} else {
					console.warn('Components index can not include nested object references: ', prop, filePath);
				}
			});
			return componentTree;
		});
}

function fulfillComponentDef(componentDef, moduleDef = {}) {
	let result = Object.assign({}, componentDef);
	const {isLibMember, absolutePath} = result;
	let defaultsFilePath;
	if (moduleDef && moduleDef.name) {
		defaultsFilePath =
			path.join(config.componentDefaultsDirPath(), moduleDef.name, `${result.name}.json`);
	} else {
		defaultsFilePath =
			path.join(config.componentDefaultsDirPath(), `${result.name}.json`);
	}
	return readJson(defaultsFilePath)
		.then(defaults => {
			if (!defaults || defaults.length <= 0) {
				throw Error('Defaults not found');
			} else {
				result.defaults = defaults;
			}
		})
		.catch(error => {
			let defaultDef = {
				type: result.name,
				variant: 'default',
				children: [],
			};
			if (moduleDef && moduleDef.name) {
				defaultDef.namespace = moduleDef.name;
			}
			result.defaults = [defaultDef];
		})
		.then(() => {
			if (!isLibMember && absolutePath) {
				const indexFilePath = path.join(absolutePath, 'index.js');
				return isExisting(indexFilePath)
					.then(() => {
						return isExisting(indexFilePath);
					})
					.then(() => {
						if (result.isContainer) {
							let reducerFilePath = path.join(absolutePath, 'reducer.js');
							return isExisting(reducerFilePath);
						}
					})
					.then(() => {
						return result;
					})
			}
			return result;
		});
}

function fulfillHtmlComponents() {
	let result = {};
	const htmlDefaultDirPath = path.join(config.componentDefaultsDirPath(), '#html');
	return readDirectoryFlat(htmlDefaultDirPath)
		.then(found => {
			let sequence = Promise.resolve();
			if (found) {
				let {files} = found;
				if (files && files.length) {
					files.sort((a, b) => {
						if (a.name > b.name) {
							return 1;
						}
						if (a.name < b.name) {
							return -1;
						}
						return 0;
					});
					files.forEach(fileDef => {
						sequence = sequence.then(() => {
							let htmlComponentName = path.basename(fileDef.name, '.json');
							let htmlComponentDef = {
								name: htmlComponentName,
							};
							return readJson(fileDef.path)
								.then(defaults => {
									if (!defaults || defaults.length <= 0) {
										throw Error('Defaults not found');
									}
									htmlComponentDef.defaults = defaults;
								})
								.catch(error => {
									let defaultDef = {
										namespace: '#html',
										type: htmlComponentName,
										variant: 'default',
										children: [],
									};
									htmlComponentDef.defaults = [defaultDef];
								})
								.then(() => {
									result[htmlComponentName] = htmlComponentDef;
								});
						});
					});
				}
			}
			return sequence;
		})
		.then(() => {
			return result;
		});
}

export function getComponentTree() {
	const filePath = config.deskIndexFilePath();
	return getIndexRefs(filePath)
		.then(componentTree => {
			let {components, modules} = componentTree;
			let sequence = Promise.resolve();
			// validating components
			if (components && !isEmpty(components)) {
				forOwn(components, (componentDef, componentId) => {
					sequence = sequence.then(() => {
						return fulfillComponentDef(componentDef)
							.then(fulfilled => {
								components[componentId] = fulfilled;
							})
							.catch(error => {
								console.error('Invalid component structure: ', componentId);
								console.error(error);
								delete components[componentId];
							});
					});
				});
			}
			// validate modules
			if (modules && !isEmpty(modules)) {
				forOwn(modules, (moduleDef, moduleId) => {
					if (moduleDef.absolutePath) {
						sequence = sequence.then(() => {
							let moduleIndexFilePath = path.join(moduleDef.absolutePath, 'index.js');
							return getIndexRefs(moduleIndexFilePath, moduleDef)
								.then(moduleComponentTree => {
									let moduleSequence = Promise.resolve();
									let {components: moduleComponents} = moduleComponentTree;
									// validating components
									if (moduleComponents && !isEmpty(moduleComponents)) {
										moduleDef.components = moduleComponents;
										forOwn(moduleComponents, (componentDef, componentId) => {
											moduleSequence = moduleSequence.then(() => {
												return fulfillComponentDef(componentDef, moduleDef)
													.then(fulfilled => {
														moduleComponents[componentId] = fulfilled;
													})
													.catch(error => {
														console.error('Invalid component structure: ', componentId);
														console.error(error);
														delete moduleComponents[componentId];
													});
											});
										});
									}
									return moduleSequence;
								})
								.catch(error => {
									console.error('Invalid module structure: ', moduleId);
									console.error(error);
									delete modules[moduleId];
								});
						});
					}
				});
			}
			return sequence.then(() => {
				return componentTree;
			});
		})
		.then(componentTree => {
			return fulfillHtmlComponents()
				.then(htmlComponents => {
					componentTree.htmlComponents = htmlComponents;
					return componentTree;
				})
		});
}