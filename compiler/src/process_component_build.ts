/*
 * Copyright (c) 2021 Huawei Device Co., Ltd.
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

import ts from 'typescript';
import path from 'path';

import {
  COMPONENT_RENDER_FUNCTION,
  COMPONENT_CREATE_FUNCTION,
  COMPONENT_POP_FUNCTION,
  COMPONENT_BUTTON,
  COMPONENT_BLANK,
  COMPONENT_CREATE_LABEL_FUNCTION,
  COMPONENT_CREATE_CHILD_FUNCTION,
  COMPONENT_FOREACH,
  COMPONENT_LAZYFOREACH,
  IS_RENDERING_IN_PROGRESS,
  FOREACH_OBSERVED_OBJECT,
  FOREACH_GET_RAW_OBJECT,
  COMPONENT_IF,
  COMPONENT_IF_BRANCH_ID_FUNCTION,
  COMPONENT_IF_UNDEFINED,
  ATTRIBUTE_ANIMATION,
  GLOBAL_CONTEXT,
  COMPONENT_GESTURE,
  COMPONENT_GESTURE_GROUP,
  GESTURE_ATTRIBUTE,
  PARALLEL_GESTURE_ATTRIBUTE,
  PRIORITY_GESTURE_ATTRIBUTE,
  GESTURE_ENUM_KEY,
  GESTURE_ENUM_VALUE_HIGH,
  GESTURE_ENUM_VALUE_LOW,
  GESTURE_ENUM_VALUE_PARALLEL,
  COMPONENT_TRANSITION_NAME,
  COMPONENT_DEBUGLINE_FUNCTION
} from './pre_define';
import {
  INNER_COMPONENT_NAMES,
  BUILDIN_CONTAINER_COMPONENT,
  BUILDIN_STYLE_NAMES,
  CUSTOM_BUILDER_METHOD,
  GESTURE_ATTRS,
  GESTURE_TYPE_NAMES,
  EXTEND_ATTRIBUTE
} from './component_map';
import { componentCollection } from './validate_ui_syntax';
import { processCustomComponent } from './process_custom_component';
import {
  LogType,
  LogInfo,
  componentInfo,
  createFunction
} from './utils';
import { projectConfig } from '../main';
import { transformLog } from './process_ui_syntax';

export const appComponentCollection: Set<string> = new Set();

export function processComponentBuild(node: ts.MethodDeclaration,
  log: LogInfo[]): ts.MethodDeclaration {
  let newNode: ts.MethodDeclaration;
  const renderNode: ts.Identifier = ts.factory.createIdentifier(COMPONENT_RENDER_FUNCTION);
  if (node.body && node.body.statements && node.body.statements.length &&
    validateRootNode(node, log)) {
    newNode = ts.factory.updateMethodDeclaration(node, node.decorators, node.modifiers,
      node.asteriskToken, renderNode, node.questionToken, node.typeParameters, node.parameters,
      node.type, processComponentBlock(node.body, false, log));
  } else {
    newNode = ts.factory.updateMethodDeclaration(node, node.decorators, node.modifiers,
      node.asteriskToken, renderNode, node.questionToken, node.typeParameters, node.parameters,
      node.type, node.body);
  }
  return newNode;
}

export function processComponentBlock(node: ts.Block, isLazy: boolean, log: LogInfo[],
  isTransition: boolean = false): ts.Block {
  const newStatements: ts.Statement[] = [];
  processComponentChild(node, newStatements, log);
  if (isLazy) {
    newStatements.unshift(createRenderingInProgress(true));
  }
  if (isTransition) {
    newStatements.unshift(ts.factory.createExpressionStatement(
      createFunction(ts.factory.createIdentifier(COMPONENT_TRANSITION_NAME),
        ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION), null)));
    newStatements.push(ts.factory.createExpressionStatement(
      createFunction(ts.factory.createIdentifier(COMPONENT_TRANSITION_NAME),
        ts.factory.createIdentifier(COMPONENT_POP_FUNCTION), null)));
  }
  if (isLazy) {
    newStatements.push(createRenderingInProgress(false));
  }
  return ts.factory.updateBlock(node, newStatements);
}

function validateRootNode(node: ts.MethodDeclaration, log: LogInfo[]): boolean {
  let isValid: boolean = false;
  if (node.body.statements.length < 4) {
    switch (node.body.statements.length) {
      case 1:
        if (validateFirstNode(node.body.statements[0])) {
          isValid = true;
        }
        break;
      case 2:
        if (validateFirstNode(node.body.statements[0]) &&
          validateBlockNode(node.body.statements[1])) {
          isValid = true;
        }
        break;
      case 3:
        if (validateFirstNode(node.body.statements[0]) &&
          validateBlockNode(node.body.statements[1]) &&
          validateSecondNode(node.body.statements[2])) {
          isValid = true;
        }
        break;
    }
  }
  if (!isValid) {
    log.push({
      type: LogType.ERROR,
      message: `There should have a root container component.`,
      pos: node.body.statements.pos
    });
  }
  return isValid;
}

function processComponentChild(node: ts.Block, newStatements: ts.Statement[],
  log: LogInfo[]): void {
  if (node.statements.length) {
    node.statements.forEach((item, index) => {
      if (ts.isExpressionStatement(item)) {
        switch (getComponentType(item, log)) {
          case ComponentType.innerComponent:
            processInnerComponent(item, index, Array.from(node.statements), newStatements, log);
            break;
          case ComponentType.customComponent:
            processCustomComponent(item, newStatements, log);
            break;
          case ComponentType.forEachComponent:
            processForEachComponent(item, newStatements, log);
            break;
          case ComponentType.customBuilderMethod:
            newStatements.push(item);
            break;
        }
      } else if (ts.isIfStatement(item)) {
        appComponentCollection.add(COMPONENT_IF);
        processIfStatement(item, newStatements, log);
      } else if (!ts.isBlock(item)) {
        log.push({
          type: LogType.ERROR,
          message: `Only UI component syntax can be written in build method.`,
          pos: item.getStart()
        });
      }
    });
  }
}

function processInnerComponent(node: ts.ExpressionStatement, index: number, arr: ts.Statement[],
  newStatements: ts.Statement[], log: LogInfo[]): void {
  const res: CreateResult = createComponent(node, COMPONENT_CREATE_FUNCTION);
  newStatements.push(res.newNode);
  if (projectConfig.isPreview) {
    const posOfNode: ts.LineAndCharacter =
      transformLog.sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const projectPath: string = projectConfig.projectPath;
    const curFileName: string = transformLog.sourceFile.fileName.replace(/.ts$/, '');
    const debugInfo: string =
      `${path.relative(projectPath, curFileName).replace(/\\+/g, '/')}` +
      `(${posOfNode.line + 1}:${posOfNode.character + 1})`;
    const debugNode: ts.ExpressionStatement = ts.factory.createExpressionStatement(
      createFunction(ts.factory.createIdentifier(getName(node)),
        ts.factory.createIdentifier(COMPONENT_DEBUGLINE_FUNCTION),
        ts.factory.createNodeArray([ts.factory.createStringLiteral(debugInfo)])));
    newStatements.push(debugNode);
  }
  if (index + 1 < arr.length && ts.isBlock(arr[index + 1])) {
    if (res.isButton) {
      if (projectConfig.isPreview) {
        newStatements.splice(-2, 1, createComponent(node, COMPONENT_CREATE_CHILD_FUNCTION).newNode);
      } else {
        newStatements.splice(-1, 1, createComponent(node, COMPONENT_CREATE_CHILD_FUNCTION).newNode);
      }
    }
    if (index + 2 < arr.length && ts.isExpressionStatement(arr[index + 2]) &&
      isAttributeNode(arr[index + 2] as ts.ExpressionStatement)) {
      bindComponentAttr(arr[index + 2] as ts.ExpressionStatement, res.identifierNode, newStatements, log);
    }
    processComponentChild(arr[index + 1] as ts.Block, newStatements, log);
  } else {
    bindComponentAttr(node, res.identifierNode, newStatements, log);
  }
  if (res.isContainerComponent || res.needPop) {
    newStatements.push(createComponent(node, COMPONENT_POP_FUNCTION).newNode);
  }
}

function processForEachComponent(node: ts.ExpressionStatement, newStatements: ts.Statement[],
  log: LogInfo[]): void {
  const popNode: ts.ExpressionStatement = ts.factory.createExpressionStatement(createFunction(
    // @ts-ignore
    node.expression.expression as ts.Identifier,
    ts.factory.createIdentifier(COMPONENT_POP_FUNCTION), null));
  if (ts.isCallExpression(node.expression)) {
    const propertyNode: ts.PropertyAccessExpression = ts.factory.createPropertyAccessExpression(
      node.expression.expression as ts.Identifier,
      ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION)
    );
    const argumentsArray: ts.Expression[] = Array.from(node.expression.arguments);
    let arrayObserveredObject: ts.CallExpression;
    if (argumentsArray.length) {
      arrayObserveredObject = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(FOREACH_OBSERVED_OBJECT),
          ts.factory.createIdentifier(FOREACH_GET_RAW_OBJECT)), undefined, [argumentsArray[0]]);
    }
    argumentsArray.splice(0, 1, arrayObserveredObject);
    const newArrowNode: ts.ArrowFunction = processForEachBlock(node.expression, log);
    if (newArrowNode) {
      argumentsArray.splice(1, 1, newArrowNode);
    }
    node = addForEachId(ts.factory.updateExpressionStatement(node, ts.factory.updateCallExpression(
      node.expression, propertyNode, node.expression.typeArguments, argumentsArray)));
  }
  newStatements.push(node, popNode);
}

function addForEachId(node: ts.ExpressionStatement): ts.ExpressionStatement {
  const forEachComponent: ts.CallExpression = node.expression as ts.CallExpression;
  return ts.factory.updateExpressionStatement(node, ts.factory.updateCallExpression(
    forEachComponent, forEachComponent.expression, forEachComponent.typeArguments,
    [ts.factory.createStringLiteral((++componentInfo.id).toString()), ts.factory.createThis(),
      ...forEachComponent.arguments]));
}

function processForEachBlock(node: ts.CallExpression, log: LogInfo[]): ts.ArrowFunction {
  if (node.arguments.length > 1 && ts.isArrowFunction(node.arguments[1])) {
    const isLazy: boolean = node.expression.getText() === COMPONENT_LAZYFOREACH;
    const arrowNode: ts.ArrowFunction = node.arguments[1] as ts.ArrowFunction;
    const body: ts.ConciseBody = arrowNode.body;
    if (node.arguments.length > 2 && !ts.isArrowFunction(node.arguments[2])) {
      log.push({
        type: LogType.ERROR,
        message: 'There should be wrapped in curly braces in ForEach.',
        pos: body.getStart()
      });
    } else if (!ts.isBlock(body)) {
      const statement: ts.Statement = ts.factory.createExpressionStatement(body);
      const blockNode: ts.Block = ts.factory.createBlock([statement], true);
      // @ts-ignore
      statement.parent = blockNode;
      return ts.factory.updateArrowFunction(
        arrowNode, arrowNode.modifiers, arrowNode.typeParameters, arrowNode.parameters,
        arrowNode.type, arrowNode.equalsGreaterThanToken, processComponentBlock(blockNode, isLazy, log));
    } else {
      return ts.factory.updateArrowFunction(
        arrowNode, arrowNode.modifiers, arrowNode.typeParameters, arrowNode.parameters,
        arrowNode.type, arrowNode.equalsGreaterThanToken, processComponentBlock(body, isLazy, log));
    }
  }
  return null;
}

function createRenderingInProgress(isTrue: boolean): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createThis(),
      ts.factory.createIdentifier(IS_RENDERING_IN_PROGRESS)
    ),
    ts.factory.createToken(ts.SyntaxKind.EqualsToken),
    isTrue ? ts.factory.createTrue() : ts.factory.createFalse()
  ));
}

function processIfStatement(node: ts.IfStatement, newStatements: ts.Statement[],
  log: LogInfo[]): void {
  const ifCreate: ts.ExpressionStatement = createIfCreate();
  const newIfNode: ts.IfStatement = processInnerIfStatement(node, 0, log);
  const ifPop: ts.ExpressionStatement = createIfPop();
  newStatements.push(ifCreate, newIfNode, ifPop);
}

function processInnerIfStatement(node: ts.IfStatement, id: number, log: LogInfo[]): ts.IfStatement {
  if (ts.isIdentifier(node.expression) && node.expression.originalKeywordKind === undefined &&
    !node.expression.escapedText) {
    log.push({
      type: LogType.ERROR,
      message: 'Condition expression cannot be null in if statement.',
      pos: node.expression.getStart()
    });
    node = ts.factory.updateIfStatement(node, ts.factory.createIdentifier(COMPONENT_IF_UNDEFINED),
      node.thenStatement, node.elseStatement);
  }
  const newThenStatement: ts.Statement = processThenStatement(node.thenStatement, id, log);
  const newElseStatement: ts.Statement = processElseStatement(node.elseStatement, id, log);
  const newIfNode: ts.IfStatement = ts.factory.updateIfStatement(
    node, node.expression, newThenStatement, newElseStatement);
  return newIfNode;
}

function processThenStatement(thenStatement: ts.Statement, id: number,
  log: LogInfo[]): ts.Statement {
  if (ts.isExpressionStatement(thenStatement) && ts.isIdentifier(thenStatement.expression) &&
    thenStatement.expression.originalKeywordKind === undefined &&
    !thenStatement.expression.escapedText) {
    log.push({
      type: LogType.ERROR,
      message: 'Then statement cannot be null in if statement.',
      pos: thenStatement.expression.getStart()
    });
  }
  if (thenStatement) {
    if (ts.isBlock(thenStatement)) {
      thenStatement = processIfBlock(thenStatement, id, log);
    } else if (ts.isIfStatement(thenStatement)) {
      thenStatement = processInnerIfStatement(thenStatement, 0, log);
      thenStatement = ts.factory.createBlock(
        [createIfCreate(), createIfBranchId(id), thenStatement, createIfPop()], true);
    } else {
      thenStatement = ts.factory.createBlock([thenStatement], true);
      thenStatement = processIfBlock(thenStatement as ts.Block, id, log);
    }
  }
  return thenStatement;
}

function processElseStatement(elseStatement: ts.Statement, id: number,
  log: LogInfo[]): ts.Statement {
  if (elseStatement) {
    if (ts.isBlock(elseStatement)) {
      elseStatement = processIfBlock(elseStatement, id + 1, log);
    } else if (ts.isIfStatement(elseStatement)) {
      elseStatement = processInnerIfStatement(elseStatement, id + 1, log);
    } else {
      elseStatement = ts.factory.createBlock([elseStatement], true);
      elseStatement = processIfBlock(elseStatement as ts.Block, id + 1, log);
    }
  }
  return elseStatement;
}

function processIfBlock(block: ts.Block, id: number, log: LogInfo[]): ts.Block {
  return addIfBranchId(id, processComponentBlock(block, false, log));
}

function addIfBranchId(id: number, container: ts.Block): ts.Block {
  return ts.factory.updateBlock(container, [createIfBranchId(id), ...container.statements]);
}

function createIf(): ts.Identifier {
  return ts.factory.createIdentifier(COMPONENT_IF);
}

function createIfCreate(): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(createFunction(createIf(),
    ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION), ts.factory.createNodeArray([])));
}

function createIfPop(): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(createFunction(createIf(),
    ts.factory.createIdentifier(COMPONENT_POP_FUNCTION), null));
}

function createIfBranchId(id: number): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(createFunction(createIf(),
    ts.factory.createIdentifier(COMPONENT_IF_BRANCH_ID_FUNCTION),
    ts.factory.createNodeArray([ts.factory.createNumericLiteral(id)])));
}

interface CreateResult {
  newNode: ts.ExpressionStatement;
  identifierNode: ts.Identifier;
  isContainerComponent: boolean;
  isButton: boolean;
  needPop: boolean;
}

function createComponent(node: ts.ExpressionStatement, type: string): CreateResult {
  const res: CreateResult = {
    newNode: node,
    identifierNode: null,
    isContainerComponent: false,
    isButton: false,
    needPop: false
  };
  let identifierNode: ts.Identifier = ts.factory.createIdentifier(type);
  let temp: any = node.expression;
  while (temp && !ts.isIdentifier(temp) && temp.expression) {
    temp = temp.expression;
  }
  if (temp && temp.parent && ts.isCallExpression(temp.parent) && ts.isIdentifier(temp)) {
    if (temp.getText() === COMPONENT_BUTTON && type !== COMPONENT_POP_FUNCTION) {
      res.isButton = true;
      identifierNode = type === COMPONENT_CREATE_CHILD_FUNCTION
        ? ts.factory.createIdentifier(COMPONENT_CREATE_CHILD_FUNCTION)
        : ts.factory.createIdentifier(COMPONENT_CREATE_LABEL_FUNCTION);
    }
    if (temp.getText() === COMPONENT_BLANK) {
      res.needPop = true;
    }
    if (BUILDIN_CONTAINER_COMPONENT.has(temp.getText())) {
      res.isContainerComponent = true;
    }
    res.newNode = type === COMPONENT_POP_FUNCTION
      ? ts.factory.updateExpressionStatement(node,
        createFunction(temp, identifierNode, null))
      : ts.factory.updateExpressionStatement(node,
        createFunction(temp, identifierNode, temp.parent.arguments));
    res.identifierNode = temp;
  }
  return res;
}

interface AnimationInfo {
  statement: ts.Statement,
  kind: boolean
}

export function bindComponentAttr(node: ts.ExpressionStatement, identifierNode: ts.Identifier,
  newStatements: ts.Statement[], log: LogInfo[], reverse: boolean = true): void {
  let temp: any = node.expression;
  const statements: ts.Statement[] = [];
  const lastStatement: AnimationInfo = { statement: null, kind: false };
  while (temp && ts.isCallExpression(temp) && temp.expression) {
    if (ts.isPropertyAccessExpression(temp.expression) &&
      temp.expression.name && ts.isIdentifier(temp.expression.name)) {
      addComponentAttr(temp, temp.expression.name, lastStatement, statements, identifierNode, log);
      temp = temp.expression.expression;
    } else if (ts.isIdentifier(temp.expression)) {
      if (!INNER_COMPONENT_NAMES.has(temp.expression.getText()) &&
        !GESTURE_TYPE_NAMES.has(temp.expression.getText())) {
        addComponentAttr(temp, temp.expression, lastStatement, statements, identifierNode, log);
      }
      break;
    }
  }
  if (lastStatement.statement && lastStatement.kind) {
    statements.push(lastStatement.statement);
  }
  if (statements.length) {
    reverse ? newStatements.push(...statements.reverse()) : newStatements.push(...statements);
  }
}

function addComponentAttr(temp: any, node: ts.Identifier, lastStatement: any,
  statements: ts.Statement[], identifierNode: ts.Identifier, log: LogInfo[]): void {
  const propName: string = node.getText();
  if (propName === ATTRIBUTE_ANIMATION) {
    if (!lastStatement.statement) {
      if (!(temp.arguments.length === 1 &&
        temp.arguments[0].kind === ts.SyntaxKind.NullKeyword)) {
        statements.push(ts.factory.createExpressionStatement(createFunction(
          ts.factory.createIdentifier(GLOBAL_CONTEXT), node,
          // @ts-ignore
          [ts.factory.createNull()])));
      }
    } else {
      statements.push(lastStatement.statement);
    }
    lastStatement.statement = ts.factory.createExpressionStatement(createFunction(
      ts.factory.createIdentifier(GLOBAL_CONTEXT), node, temp.arguments));
    lastStatement.kind = false;
  } else if (GESTURE_ATTRS.has(propName)) {
    parseGesture(temp, propName, statements, log);
    lastStatement.kind = true;
  } else if (isExtendFunctionNode(identifierNode, propName)) {
    validateExtendParameterCount(temp, identifierNode, propName, log);
    statements.push(ts.factory.createExpressionStatement(ts.factory.createCallExpression(
      ts.factory.createIdentifier(`__${identifierNode.escapedText.toString()}__${propName}`),
      undefined, temp.arguments)));
    lastStatement.kind = true;
  } else {
    statements.push(ts.factory.createExpressionStatement(
      createFunction(identifierNode, node, temp.arguments)));
    lastStatement.kind = true;
  }
}

function isExtendFunctionNode(identifierNode: ts.Identifier, propName: string): boolean {
  if (identifierNode && EXTEND_ATTRIBUTE.has(identifierNode.escapedText.toString())) {
    const attributeArray: string[] =
      [...EXTEND_ATTRIBUTE.get(identifierNode.escapedText.toString())].map(item => item.attribute);
    if (attributeArray.includes(propName)) {
      return true;
    }
  }
  return false;
}

const gestureMap: Map<string, string> = new Map([
  [PRIORITY_GESTURE_ATTRIBUTE, GESTURE_ENUM_VALUE_HIGH],
  [PARALLEL_GESTURE_ATTRIBUTE, GESTURE_ENUM_VALUE_PARALLEL],
  [GESTURE_ATTRIBUTE, GESTURE_ENUM_VALUE_LOW]
]);

function parseGesture(node: ts.CallExpression, propName: string, statements: ts.Statement[],
  log: LogInfo[]): void {
  statements.push(ts.factory.createExpressionStatement(
    createFunction(ts.factory.createIdentifier(COMPONENT_GESTURE),
      ts.factory.createIdentifier(COMPONENT_POP_FUNCTION), null)));
  parseGestureInterface(node, statements, log);
  const argumentArr: ts.NodeArray<ts.PropertyAccessExpression> = ts.factory.createNodeArray(
    [ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier(GESTURE_ENUM_KEY),
      ts.factory.createIdentifier(gestureMap.get(propName)))
    ]
  );
  if (node.arguments && node.arguments.length > 1 &&
    ts.isPropertyAccessExpression(node.arguments[1])) {
    // @ts-ignore
    argumentArr.push(node.arguments[1]);
  }
  statements.push(ts.factory.createExpressionStatement(
    createFunction(ts.factory.createIdentifier(COMPONENT_GESTURE),
      ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION), argumentArr)));
}

function processGestureType(node: ts.CallExpression, statements: ts.Statement[], log: LogInfo[],
  reverse: boolean = false): void {
  const newStatements: ts.Statement[] = [];
  const newNode: ts.ExpressionStatement = ts.factory.createExpressionStatement(node);
  let temp: any = node.expression;
  while (temp && !ts.isIdentifier(temp) && temp.expression) {
    temp = temp.expression;
  }
  if (temp && temp.parent && ts.isCallExpression(temp.parent) && ts.isIdentifier(temp) &&
    GESTURE_TYPE_NAMES.has(temp.escapedText.toString())) {
    newStatements.push(ts.factory.createExpressionStatement(
      createFunction(temp, ts.factory.createIdentifier(COMPONENT_POP_FUNCTION), null)));
    if (temp.escapedText.toString() === COMPONENT_GESTURE_GROUP) {
      const gestureStatements: ts.Statement[] = [];
      parseGestureInterface(temp.parent, gestureStatements, log, true);
      newStatements.push(...gestureStatements.reverse());
      bindComponentAttr(newNode, temp, newStatements, log, false);
      let argumentArr: ts.NodeArray<ts.Expression> = null;
      if (temp.parent.arguments && temp.parent.arguments.length) {
        // @ts-ignore
        argumentArr = ts.factory.createNodeArray([temp.parent.arguments[0]]);
      }
      newStatements.push(ts.factory.createExpressionStatement(
        createFunction(temp, ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION), argumentArr)));
    } else {
      bindComponentAttr(newNode, temp, newStatements, log, false);
      newStatements.push(ts.factory.createExpressionStatement(
        createFunction(temp, ts.factory.createIdentifier(COMPONENT_CREATE_FUNCTION), temp.parent.arguments)));
    }
  }
  if (newStatements.length) {
    reverse ? statements.push(...newStatements.reverse()) : statements.push(...newStatements);
  }
}

function parseGestureInterface(node: ts.CallExpression, statements: ts.Statement[], log: LogInfo[],
  reverse: boolean = false): void {
  if (node.arguments && node.arguments.length) {
    node.arguments.forEach((item: ts.Node) => {
      if (ts.isCallExpression(item)) {
        processGestureType(item, statements, log, reverse);
      }
    });
  }
}

export function getName(node: ts.ExpressionStatement): string {
  let temp: any = node.expression;
  let name: string;
  while (temp) {
    if (ts.isIdentifier(temp) && temp.parent && ts.isCallExpression(temp.parent)) {
      name = temp.escapedText.toString();
      break;
    } else if (ts.isPropertyAccessExpression(temp) && temp.name && ts.isIdentifier(temp.name) &&
      !BUILDIN_STYLE_NAMES.has(temp.name.escapedText.toString())) {
      name = temp.name.escapedText.toString();
      break;
    }
    temp = temp.expression;
  }
  return name;
}

export function isAttributeNode(node: ts.ExpressionStatement): boolean {
  let temp: any = node.expression;
  let name: string;
  while (temp) {
    if (ts.isCallExpression(temp) && temp.expression && ts.isIdentifier(temp.expression)) {
      name = temp.expression.escapedText.toString();
      break;
    }
    temp = temp.expression;
  }
  return BUILDIN_STYLE_NAMES.has(name);
}

function validateFirstNode(node: ts.Statement): boolean {
  const isEntryComponent: boolean =
    componentCollection.entryComponent === componentCollection.currentClassName;
  if ((isEntryComponent && validateEntryComponent(node)) ||
    (!isEntryComponent && validateCustomComponent(node))) {
    return true;
  }
  return false;
}

function validateEntryComponent(node: ts.Statement): boolean {
  if (ts.isExpressionStatement(node) && BUILDIN_CONTAINER_COMPONENT.has(getName(node))) {
    return true;
  }
  return false;
}

function validateCustomComponent(node: ts.Statement): boolean {
  if (ts.isIfStatement(node) ||
    (ts.isExpressionStatement(node) && (INNER_COMPONENT_NAMES.has(getName(node)) ||
      componentCollection.customComponents.has(getName(node))))) {
    return true;
  }
  return false;
}

function validateBlockNode(node: ts.Statement): boolean {
  if (ts.isBlock(node)) {
    return true;
  }
  return false;
}

function validateSecondNode(node: ts.Statement): boolean {
  if (ts.isExpressionStatement(node) && isAttributeNode(node)) {
    return true;
  }
  return false;
}

enum ComponentType {
  innerComponent,
  customComponent,
  forEachComponent,
  customBuilderMethod
}

function getComponentType(node: ts.ExpressionStatement, log: LogInfo[]): ComponentType {
  const name: string = getName(node);
  if (INNER_COMPONENT_NAMES.has(name)) {
    return ComponentType.innerComponent;
  } else if (componentCollection.customComponents.has(name)) {
    return ComponentType.customComponent;
  } else if (name === COMPONENT_FOREACH || name === COMPONENT_LAZYFOREACH) {
    appComponentCollection.add(name);
    return ComponentType.forEachComponent;
  } else if (CUSTOM_BUILDER_METHOD.has(name)) {
    return ComponentType.customBuilderMethod;
  } else if (!isAttributeNode(node)) {
    log.push({
      type: LogType.ERROR,
      message: `'${node.getText()}' does not meet UI component syntax.`,
      pos: node.getStart()
    });
  }
  return null;
}

function validateExtendParameterCount(temp: any, identifierNode: ts.Identifier, propName: string,
  log: LogInfo[]): void {
  const parameterCount: number =
    [...EXTEND_ATTRIBUTE.get(identifierNode.escapedText.toString())].filter(item =>
      item.attribute === propName)[0].parameterCount;
  if (temp.arguments && temp.arguments.length !== parameterCount) {
    log.push({
      type: LogType.ERROR,
      message: `The '${propName}' is expected ${parameterCount} arguments, but got ${temp.arguments.length}.`,
      pos: temp.getStart()
    });
  }
}
