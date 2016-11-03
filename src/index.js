import fs from 'fs';
import {
  parse,
  validate,
  buildClientSchema,
} from 'graphql';

import {
  without,
} from 'lodash';

const graphQLValidationRuleNames = [
  'UniqueOperationNames',
  'LoneAnonymousOperation',
  'KnownTypeNames',
  'FragmentsOnCompositeTypes',
  'VariablesAreInputTypes',
  'ScalarLeafs',
  'FieldsOnCorrectType',
  'UniqueFragmentNames',
  //'KnownFragmentNames', -> any interpolation
  //'NoUnusedFragments', -> any standalone fragment
  'PossibleFragmentSpreads',
  'NoFragmentCycles',
  'UniqueVariableNames',
  'NoUndefinedVariables',
  'NoUnusedVariables',
  'KnownDirectives',
  'KnownArgumentNames',
  'UniqueArgumentNames',
  'ArgumentsOfCorrectType',
  'ProvidedNonNullArguments',
  'DefaultValuesOfCorrectType',
  'VariablesInAllowedPosition',
  'OverlappingFieldsCanBeMerged',
  'UniqueInputFieldNames',
];

// Omit these rules when in Relay env
const relayRuleNames = without(graphQLValidationRuleNames,
  'ScalarLeafs',
  'ProvidedNonNullArguments',
  'KnownDirectives',
  'NoUndefinedVariables',
);

const graphQLValidationRules = graphQLValidationRuleNames.map((ruleName) => {
  return require(`graphql/validation/rules/${ruleName}`)[ruleName];
});

const relayGraphQLValidationRules = relayRuleNames.map((ruleName) => {
  return require(`graphql/validation/rules/${ruleName}`)[ruleName];
});

const rules = {
  'template-strings'(context) {
    const {
      // Schema via JSON object
      schemaJson,
      // Or schema via filepath
      watchSchemaJson, // absolute path to JSON file
      watchInterval = 5000, // watch interval in ms for non-blocking setTimeout
      // Rest common options
      env,
      tagName: tagNameOption,
    } = context.options[0];

    // Validate and unpack schema
    let schema;

    function initSchema(json) {
      const unpackedSchemaJson = json.data ? json.data : json;
      if (! unpackedSchemaJson.__schema) {
        throw new Error('Please pass a valid GraphQL introspection query result.');
      }
      schema = buildClientSchema(unpackedSchemaJson);
    }

    function initSchemaFromFile(jsonFile) {
      initSchema(JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
    }

    if (schemaJson) {
      initSchema(schemaJson);
    } else if(watchSchemaJson) {
      let prevMtime;
      const watcherFn = () => {
        try {
          const stats = fs.statSync(watchSchemaJson);
          if (stats) {
            if (!prevMtime) prevMtime = stats.mtime;
            if (stats.mtime.getTime() !== prevMtime.getTime()) {
              prevMtime = stats.mtime;
              initSchemaFromFile(watchSchemaJson);
            }
          }
          setTimeout(watcherFn, watchInterval).unref(); // unref() allows exit to process
        } catch (e) {
          console.log('[eslint-plugin-graphql]', e);
        }
      };
      initSchemaFromFile(watchSchemaJson);
      watcherFn();
    } else {
      throw new Error('Must pass in `schemaJson` option with schema object '
                    + 'or `watchSchemaJson` with absolute path to the json file.');
    }

    // Validate env
    if (env && env !== 'lokka' && env !== 'relay' && env !== 'apollo') {
      throw new Error('Invalid option for env, only `apollo`, `lokka`, and `relay` supported.')
    }

    // Validate tagName and set default
    let tagName;
    if (tagNameOption) {
      tagName = tagNameOption;
    } else if (env === 'relay') {
      tagName = 'Relay.QL';
    } else {
      tagName = 'gql';
    }

    return {
      TaggedTemplateExpression(node) {
        const tagNameSegments = tagName.split('.').length;
        if (tagNameSegments === 1) {
          // Check for single identifier, like 'gql'
          if (node.tag.type === 'Identifier' && node.tag.name !== tagName) {
            return;
          }
        } else if (tagNameSegments === 2){
          // Check for dotted identifier, like 'Relay.QL'
          if (node.tag.type === 'MemberExpression' &&
              node.tag.object.name + '.' + node.tag.property.name !== tagName) {
            return;
          }
        }

        let text;
        try {
          text = replaceExpressions(node.quasi, context, env);
        } catch (e) {
          if (e.message !== 'Invalid interpolation') {
            console.log(e);
          }

          return;
        }

        // Re-implement syntax sugar for fragment names, which is technically not valid
        // graphql
        if ((env === 'lokka' || env === 'relay') && /fragment\s+on/.test(text)) {
          text = text.replace('fragment', `fragment _`);
        }

        let ast;

        try {
          ast = parse(text);
        } catch (error) {
          context.report({
            node,
            message: error.message.split('\n')[0],
            loc: locFrom(node, error),
          });
          return;
        }

        const rules = (env === 'relay' ? relayGraphQLValidationRules : graphQLValidationRules);

        const validationErrors = schema ? validate(schema, ast, rules) : [];

        if (validationErrors && validationErrors.length > 0) {
          context.report({
            node,
            message: validationErrors[0].message,
            loc: locFrom(node, validationErrors[0]),
          });
          return;
        }
      }
    };
  }
}

function locFrom(node, error) {
  const location = error.locations[0];

  let line;
  let column;
  if (location.line === 1) {
    line = node.loc.start.line;
    column = node.loc.start.col + location.col;
  } else {
    line = node.loc.start.line + location.line;
    column = location.column - 1;
  }

  return {
    line,
    column,
  };
}

function replaceExpressions(node, context, env) {
  const chunks = [];

  node.quasis.forEach((element, i) => {
    const chunk = element.value.cooked;

    chunks.push(chunk);

    if (!element.tail) {
      const value = node.expressions[i];

      // Preserve location of errors by replacing with exactly the same length
      const nameLength = value.end - value.start;

      if (env === 'relay' && /:\s*$/.test(chunk)) {
        // The chunk before this one had a colon at the end, so this
        // is a variable

        // Add 2 for brackets in the interpolation
        const placeholder = strWithLen(nameLength + 2)
        chunks.push('$' + placeholder);
      } else if (env === 'lokka' && /\.\.\.\s*$/.test(chunk)) {
        // This is Lokka-style fragment interpolation where you actually type the '...' yourself
        const placeholder = strWithLen(nameLength + 3);
        chunks.push(placeholder);
      } else if (env === 'relay') {
        // This is Relay-style fragment interpolation where you don't type '...'
        // Ellipsis cancels out extra characters
        const placeholder = strWithLen(nameLength);
        chunks.push('...' + placeholder);
      } else {
        // Invalid interpolation
        context.report({
          node: value,
          message: 'Invalid interpolation - not a valid fragment or variable.',
        });
        throw new Error('Invalid interpolation');
      }
    }
  });

  return chunks.join('').trim();
}

function strWithLen(len) {
  // from http://stackoverflow.com/questions/14343844/create-a-string-of-variable-length-filled-with-a-repeated-character
  return new Array(len + 1).join( 'x' );
}

export { rules };
