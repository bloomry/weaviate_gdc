import {
  ComparisonColumn,
  ComparisonValue,
  Expression,
  Field,
  Query,
  QueryRequest,
  QueryResponse,
  ScalarType,
  ScalarValue,
} from "@hasura/dc-api-types";
import { Config } from "../config";
import { WhereFilter } from "weaviate-ts-client";
import { getWeaviateClient } from "../weaviate";
import { builtInPropertiesKeys } from "./schema";

function column_name(column: ComparisonColumn): string {
  if (Array.isArray(column.name)) {
    return column.name.join(".");
  } else {
    return column.name;
  }
}

export async function executeQuery(
  query: QueryRequest,
  config: Config
): Promise<QueryResponse> {
  if (query.target.type !== "table") {
    throw new Error("Only table requests are supported");
  }

  const queryTableName = query.target.name[0];

  // handle requests by primary key
  if (
    query.query.where?.type === "binary_op" &&
    query.query.where.operator === "equal" &&
    query.query.where.column.name === "id" &&
    query.query.where.value.type === "scalar"
  ) {
    return executeQueryById(
      query.query.where.value.value,
      queryTableName,
      query.query,
      config
    );
  }

  if (query.foreach) {
    const queries = query.foreach.map((foreach) => {
      // todo: build where filter as a map of columns and values
      const where: WhereFilter = {
        operator: "And",
        operands: Object.entries(foreach).map(([column, value]) => ({
          operator: "Equal",
          path: [column],
          ...expressionScalarValue(value),
        })),
      };
      return executeSingleQuery(where, queryTableName, query.query, config);
    });

    return Promise.all(queries).then((results) => ({
      rows: results.map((query) => ({ query })),
    }));
  } else {
    return executeSingleQuery(null, queryTableName, query.query, config);
  }
}

async function executeQueryById(
  id: string,
  table: string,
  query: Query,
  config: Config
) {
  const getter = await getWeaviateClient(config)
    .data.getterById()
    .withClassName(table)
    .withId(id);

  if (query.fields && "vector" in query.fields) {
    getter.withVector();
  }

  const response = await getter.do();

  return {
    rows: [
      Object.fromEntries(
        Object.entries(query.fields!).map(([alias, field]) => {
          if (field.type === "column") {
            if (builtInPropertiesKeys.includes(field.column)) {
              return [alias, response[field.column as keyof typeof response]];
            } else {
              return [
                alias,
                response.properties![
                field.column as keyof typeof response.properties
                ],
              ];
            }
          } else if (field.type === "array" && field.field.type === "column") {
            if (builtInPropertiesKeys.includes(field.field.column)) {
              return [
                alias,
                response[field.field.column as keyof typeof response],
              ];
            } else {
              return [
                alias,
                response.properties![
                field.field.column as keyof typeof response.properties
                ],
              ];
            }
          }
          throw new Error(`field of type ${field.type} not supported`);
        })
      ) as Record<string, QueryResponse>, // assertion not safe, but necessary. I hate typescript
    ],
  };
}

async function executeSingleQuery(
  forEachWhere: WhereFilter | null,
  table: string,
  query: Query,
  config: Config
) {
  const getter = getWeaviateClient(config).graphql.get();

  getter.withClassName(table);

  if (query.fields) {
    // const additionalFields = query.query.fields.filter()
    // todo: filter out additional properties into the _additional field.
    const fieldsString = queryFieldsAsString(query.fields);
    getter.withFields(fieldsString);
  }

  if (query.limit) {
    getter.withLimit(query.limit);
  }

  if (query.offset) {
    getter.withOffset(query.offset);
  }

  if (query.where) {
    const searchTextFilter = getSearchTextFilter(query.where);

    if ((searchTextFilter.length > 0) && isNearTextFilter(query.where)) {
      getter.withNearText({
        concepts: searchTextFilter,
      });
    } else if ((searchTextFilter.length > 0) && isMatchTextFilter(query.where)) {
      getter.withBm25({
        query: searchTextFilter.toString(),
      });
    }
  }

  if (forEachWhere) {
    if (query.where) {
      const where = queryWhereOperator(query.where);

      if (where !== null) {
        getter.withWhere({
          operator: "And",
          operands: [where, forEachWhere],
        });
      } else {
        getter.withWhere(forEachWhere);
      }
    } else {
      getter.withWhere(forEachWhere);
    }
  } else if (query.where) {
    const where = queryWhereOperator(query.where);
    if (where !== null) {
      getter.withWhere(where);
    }
  }

  const response = await getter.do();

  const rows = response.data.Get[table].map((row: any) =>
    Object.fromEntries(
      Object.entries(query.fields!).map(([alias, field]) => {
        if (
          field.type === "column" &&
          builtInPropertiesKeys.includes(field.column)
        ) {
          const value =
            row[alias as keyof typeof row][field.column as keyof typeof row];
          return [alias, value];
        }
        if (
          field.type === "array" &&
          field.field.type === "column" &&
          builtInPropertiesKeys.includes(field.field.column)
        ) {
          const value =
            row[alias as keyof typeof row][
            field.field.column as keyof typeof row
            ];
          return [alias, value];
        }
        if (
          field.type === "relationship" &&
          builtInPropertiesKeys.includes(field.relationship)
        ) {
          const value =
            row[alias as keyof typeof row][
            field.relationship as keyof typeof row
            ];
          return [alias, value];
        }
        const value = row[alias as keyof typeof row];
        return [alias, value];
      })
    )
  );

  return { rows };
}

function isNearTextFilter(expression: Expression): boolean {
  switch (expression.type) {
    case "not":
      return isNearTextFilter(expression.expression);
    case "and":
    case "or":
      return expression.expressions.some(isNearTextFilter);
    case "binary_op":
      return expression.operator === "near_text";
    default:
      return false;
  }
}

function isMatchTextFilter(expression: Expression): boolean {
  switch (expression.type) {
    case "not":
      return isMatchTextFilter(expression.expression);
    case "and":
    case "or":
      return expression.expressions.some(isMatchTextFilter);
    case "binary_op":
      return expression.operator === "match_text";
    default:
      return false;
  }
}

function getSearchTextFilter(
  expression: Expression,
  negated = false,
  ored = false
): string[] {
  switch (expression.type) {
    case "not":
      return getSearchTextFilter(expression.expression, !negated, ored);
    case "and":
      return expression.expressions
        .map((expression) => getSearchTextFilter(expression, negated, ored))
        .flat()
        .filter((filter) => filter !== null);
    case "or":
      return expression.expressions
        .map((expression) => getSearchTextFilter(expression, negated, true))
        .flat()
        .filter((filter) => filter !== null);
    case "binary_op":
      switch (expression.operator) {
        case "near_text":
        case "match_text":
          if (negated) {
            throw new Error("Negated near_text or match_text not supported");
          }
          if (ored) {
            throw new Error("Ored near_text or match_text not supported");
          }
          switch (expression.value.type) {
            case "scalar":
              return [expression.value.value];
            case "column":
              throw new Error("Column comparison not implemented");
          }
        default:
          return [];
      }
    default:
      return [];
  }
}

export function queryWhereOperator(
  expression: Expression,
  path: string[] = []
): WhereFilter | null {
  switch (expression.type) {
    case "not":
      const expr = queryWhereOperator(expression.expression, path);
      if (expr === null) {
        return null;
      }
      return {
        operator: "Not",
        operands: [expr],
      };
    case "and":
      if (expression.expressions.length < 1) return null;
      return {
        operator: "And",
        operands: expression.expressions.reduce<WhereFilter[]>(
          (exprs: WhereFilter[], expression: Expression): WhereFilter[] => {
            const expr = queryWhereOperator(expression, path);
            if (expr !== null) {
              exprs.push(expr);
            }
            return exprs;
          },
          []
        ),
      };
    case "or":
      if (expression.expressions.length < 1) return null;
      return {
        operator: "Or",
        operands: expression.expressions.reduce<WhereFilter[]>(
          (exprs: WhereFilter[], expression: Expression): WhereFilter[] => {
            const expr = queryWhereOperator(expression, path);
            if (expr !== null) {
              exprs.push(expr);
            }
            return exprs;
          },
          []
        ),
      };
    case "binary_op":
      switch (expression.operator) {
        case "equal":
          return {
            operator: "Equal",
            path: [...path, column_name(expression.column)],
            ...expressionValue(expression.value),
          };
        case "less_than":
          return {
            operator: "LessThan",
            path: [...path, column_name(expression.column)],
            ...expressionValue(expression.value),
          };
        case "less_than_or_equal":
          return {
            operator: "LessThanEqual",
            path: [...path, column_name(expression.column)],
            ...expressionValue(expression.value),
          };
        case "greater_than":
          return {
            operator: "GreaterThan",
            path: [...path, column_name(expression.column)],
            ...expressionValue(expression.value),
          };
        case "greater_than_or_equal":
          return {
            operator: "GreaterThanEqual",
            path: [...path, column_name(expression.column)],
            ...expressionValue(expression.value),
          };
        case "near_text":
        case "match_text":
          // silently ignore near_text and match_text operator
          return null;
        default:
          throw new Error(
            `Unsupported binary comparison operator: ${expression.operator}`
          );
      }
    case "unary_op":
      switch (expression.operator) {
        case "is_null":
          return {
            operator: "IsNull",
            path: [...path, column_name(expression.column)],
          };
        default:
          throw new Error(
            `Unsupported unary comparison operator: ${expression.operator}`
          );
      }
    case "binary_arr_op":
      switch (expression.operator) {
        case "in":
          if (expression.values.length < 1) return null;
          return {
            operator: "Or",
            operands: expression.values.map((value) => ({
              operator: "Equal",
              path: [...path, column_name(expression.column)],
              [expressionValueType(expression.value_type)]: value,
            })),
          };
        default:
          throw new Error(
            `Unsupported binary array comparison operator: ${expression.operator}`
          );
      }
    default:
      throw new Error(`Unsupported expression type: ${expression.type}`);
  }
}

function expressionValueType(value_type: ScalarType): string {
  switch (value_type) {
    case "text":
      return "valueText";
    case "int":
      return "valueInt";
    case "boolean":
      return "valueBoolean";
    case "number":
      return "valueNumber";
    case "date":
      return "valueDate";
    case "uuid":
      return "valueText";
    case "geoCoordinates":
      return "valueText";
    case "phoneNumber":
      return "valueText";
    case "blob":
      return "valueText";
    default:
      throw new Error(`Unknown scalar type: ${value_type}`);
  }
}

function expressionValue(value: ComparisonValue) {
  switch (value.type) {
    case "scalar":
      switch (value.value_type) {
        case "text":
          return { valueText: value.value };
        case "int":
          return { valueInt: value.value };
        case "boolean":
          return { valueBoolean: value.value };
        case "number":
          return { valueNumber: value.value };
        case "date":
          return { valueDate: value.value };
        case "uuid":
          return { valueText: value.value };
        case "geoCoordinates":
          return { valueText: value.value };
        case "phoneNumber":
          return { valueText: value.value };
        case "blob":
          return { valueText: value.value };
        default:
          throw new Error(`Unknown scalar type: ${value.value_type}`);
      }
    case "column":
      throw new Error("Column comparison not implemented");
  }
}

function expressionScalarValue(value: ScalarValue) {
  switch (value.value_type) {
    case "text":
      return { valueText: value.value };
    case "int":
      return { valueInt: value.value };
    case "boolean":
      return { valueBoolean: value.value };
    case "number":
      return { valueNumber: value.value };
    case "date":
      return { valueDate: value.value };
    case "uuid":
      return { valueText: value.value };
    case "geoCoordinates":
      return { valueText: value.value };
    case "phoneNumber":
      return { valueText: value.value };
    case "blob":
      return { valueText: value.value };
    default:
      throw new Error(`Unknown scalar type: ${value.value_type}`);
  }
}

function queryFieldsAsString(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([alias, field]) => {
      return `${alias}: ${fieldString(field)}`;
    })
    .join(" ");
}

// given a field, returns the graphql string for that field
// does not return the alias
// note we currently don't handle built-in objects or relationships.
function fieldString(field: Field): string {
  switch (field.type) {
    case "object":
      return `${field.column} { ${queryFieldsAsString(field.query.fields!)} }`;
    case "relationship":
      return field.relationship;
    case "column":
      if (builtInPropertiesKeys.includes(field.column)) {
        return `_additional { ${field.column} }`;
      }
      return field.column;
    case "array":
      return fieldString(field.field);
  }
}
