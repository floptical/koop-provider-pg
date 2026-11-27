const { table: sql } = require('../sql')
const { createLogger } = require('../../utils/logger')
const { DatabaseError, ValidationError } = require('../../utils/errors')
const { quoteIdentifier } = require('../../utils/queryBuilder')

const log = createLogger('DataRepository')

// PostgreSQL SQLSTATE codes that indicate a client query error (HTTP 400) rather than a server failure
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const CLIENT_SQLSTATE_CODES = new Set([
  '42703', // undefined_column
  '42883', // undefined_function (e.g. incompatible types for operator)
  '42601', // syntax_error
  '22P02', // invalid_text_representation
  '22003', // numeric_value_out_of_range
  '22007', // invalid_datetime_format
  '22008' // datetime_field_overflow
])

function formatTableName (tableRef) {
  const parts = String(tableRef).split('.')
  if (parts.length === 2) {
    return `${quoteIdentifier(parts[0], 'schema')}.${quoteIdentifier(parts[1], 'table')}`
  }
  return quoteIdentifier(tableRef, 'table')
}

class DataRepository {
  constructor (db, pgp) {
    this.db = db
    this.pgp = pgp
  }

  async getGeometryColumnName (schema, table) {
    try {
      const result = await this.db.oneOrNone(sql.getGeometryColumnName, {
        schema: schema,
        table: table
      })

      return result
    } catch (error) {
      const dbError = new DatabaseError(
        'Failed to query geometry column information',
        error,
        { schema, table }
      )

      log.error('Error in getGeometryColumnName', error, { schema, table })
      throw dbError
    }
  }

  async getCount (tableRef, whereSql = '', params = []) {
    try {
      const quotedTable = formatTableName(tableRef)

      // Fast path for unfiltered counts on large tables (>= 10k rows):
      // avoids a full multi-million-row MVCC scan on AGOL Data tab's where=1=1&returnCountOnly=true.
      if (!whereSql && process.env.PG_EXACT_COUNT !== 'true') {
        const parts = String(tableRef).split('.')
        if (parts.length === 2) {
          try {
            const est = await this.db.oneOrNone(
              `SELECT c.reltuples::bigint AS count
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1
                 AND c.relname = $2
                 AND c.relkind IN ('r', 'p', 'm')
                 AND c.reltuples >= 10000;`,
              [parts[0], parts[1]]
            )
            if (est && Number.isFinite(Number(est.count))) {
              return Number(est.count)
            }
          } catch (estError) {
            log.debug('pg_class count estimate unavailable, falling back to COUNT(*)', {
              table: tableRef,
              reason: estError.message
            })
          }
        }
      }

      const query = `SELECT COUNT(*)::int AS count FROM ${quotedTable} t ${whereSql};`
      const result = await this.db.one(query, params)
      return result.count
    } catch (error) {
      if (error instanceof ValidationError) throw error
      if (error && CLIENT_SQLSTATE_CODES.has(error.code)) {
        throw new ValidationError(`Invalid query: ${error.message}`, {
          table: tableRef,
          pgCode: error.code
        })
      }

      const dbError = new DatabaseError(
        'Failed to count PostGIS features',
        error,
        { table: tableRef }
      )

      log.error('Error in getCount', error, { table: tableRef })
      throw dbError
    }
  }

  async getExtent (schema, table, geom, srid) {
    const sridNum = Number(srid)
    const parseExtentRow = (row) => {
      if (!row) return null
      const xmin = Number(row.xmin)
      const ymin = Number(row.ymin)
      const xmax = Number(row.xmax)
      const ymax = Number(row.ymax)
      if (![xmin, ymin, xmax, ymax].every(Number.isFinite)) return null
      return {
        xmin,
        ymin,
        xmax,
        ymax,
        spatialReference: { wkid: 4326, latestWkid: 4326 }
      }
    }

    // Fast path: O(1) lookup via PostGIS table statistics
    try {
      const estimatedQuery = `
        WITH ext AS (
          SELECT ST_EstimatedExtent($1, $2, $3) AS box
        ),
        wgs84 AS (
          SELECT CASE
            WHEN box IS NULL THEN NULL
            WHEN $4 = 4326 THEN ST_SetSRID(box::geometry, 4326)
            ELSE ST_Transform(ST_SetSRID(box::geometry, $4), 4326)
          END AS geom
          FROM ext
        )
        SELECT
          ST_XMin(geom) AS xmin,
          ST_YMin(geom) AS ymin,
          ST_XMax(geom) AS xmax,
          ST_YMax(geom) AS ymax
        FROM wgs84
        WHERE geom IS NOT NULL;
      `
      const estimated = parseExtentRow(
        await this.db.oneOrNone(estimatedQuery, [schema, table, geom, sridNum])
      )
      if (estimated) return estimated
    } catch (error) {
      log.debug('ST_EstimatedExtent unavailable, falling back to ST_Extent', {
        schema,
        table,
        geom,
        reason: error.message
      })
    }

    // Fallback: exact table extent (e.g. views or un-analyzed tables)
    try {
      const quotedGeom = quoteIdentifier(geom, 'geometry column')
      const quotedTable = formatTableName(`${schema}.${table}`)
      const exactQuery = `
        WITH ext AS (
          SELECT ST_Extent(t.${quotedGeom}) AS box
          FROM ${quotedTable} t
        ),
        wgs84 AS (
          SELECT CASE
            WHEN box IS NULL THEN NULL
            WHEN $1 = 4326 THEN ST_SetSRID(box::geometry, 4326)
            ELSE ST_Transform(ST_SetSRID(box::geometry, $1), 4326)
          END AS geom
          FROM ext
        )
        SELECT
          ST_XMin(geom) AS xmin,
          ST_YMin(geom) AS ymin,
          ST_XMax(geom) AS xmax,
          ST_YMax(geom) AS ymax
        FROM wgs84
        WHERE geom IS NOT NULL;
      `
      return parseExtentRow(await this.db.oneOrNone(exactQuery, [sridNum]))
    } catch (error) {
      log.warn('Failed to compute table extent', {
        schema,
        table,
        geom,
        reason: error.message
      })
      return null
    }
  }

  async hasMoreThan (tableRef, whereSql = '', params = [], limit = 2000) {
    try {
      const quotedTable = formatTableName(tableRef)
      const queryParams = [...params, limit]
      const offsetParam = `$${queryParams.length}`
      const query = `SELECT 1 AS hit FROM ${quotedTable} t ${whereSql} OFFSET ${offsetParam} LIMIT 1;`
      const result = await this.db.oneOrNone(query, queryParams)
      return Boolean(result)
    } catch (error) {
      if (error instanceof ValidationError) throw error
      if (error && CLIENT_SQLSTATE_CODES.has(error.code)) {
        throw new ValidationError(`Invalid query: ${error.message}`, {
          table: tableRef,
          pgCode: error.code
        })
      }

      const dbError = new DatabaseError(
        'Failed to check PostGIS feature limit',
        error,
        { table: tableRef, limit }
      )

      log.error('Error in hasMoreThan', error, { table: tableRef, limit })
      throw dbError
    }
  }

  async createGeoJson (id, geom, srid, values, limit, offset, queryOptions = {}) {
    try {
      const {
        whereSql = '',
        orderBySql,
        params = [],
        outFields = null,
        returnGeometry = true,
        materializeFilter = false
      } = queryOptions
      const quotedId = quoteIdentifier(id, 'id')
      const quotedGeom = quoteIdentifier(geom, 'geometry column')
      const quotedTable = formatTableName(values)
      const effectiveOrderBy = orderBySql === undefined
        ? `t.${quotedId} ASC`
        : orderBySql
      const orderByClause = effectiveOrderBy ? `ORDER BY ${effectiveOrderBy}` : ''

      // GeoJSON (RFC 7946) and Koop expect WGS84 (EPSG:4326) coordinates
      let geomExpr = 'NULL::jsonb'
      if (returnGeometry) {
        geomExpr = Number(srid) === 4326
          ? `ST_AsGeoJSON(t.${quotedGeom})::jsonb`
          : `ST_AsGeoJSON(ST_Transform(t.${quotedGeom}, 4326))::jsonb`
      }

      const queryParams = [...params]
      let propsExpr
      if (Array.isArray(outFields) && outFields.length > 0) {
        const pairs = outFields.map(field => {
          const quotedField = quoteIdentifier(field, 'outFields column')
          return `'${field}', t.${quotedField}`
        })
        propsExpr = `jsonb_build_object(${pairs.join(', ')})`
      } else {
        const geomNameParam = `$${queryParams.length + 1}`
        queryParams.push(geom)
        propsExpr = `to_jsonb(t) - ${geomNameParam}`
      }

      const limitParam = `$${queryParams.length + 1}`
      queryParams.push(limit)
      const offsetParam = `$${queryParams.length + 1}`
      queryParams.push(offset)

      // When materializeFilter is enabled (e.g. spatial tile query already verified to have
      // <= limit rows), materialize the WHERE clause first so PostgreSQL uses the GiST spatial
      // index and sorts the small result set in memory rather than scanning the PK index.
      const filteredCte = materializeFilter && whereSql
        ? `
        WITH matched AS MATERIALIZED (
          SELECT t.*
          FROM ${quotedTable} t
          ${whereSql}
        ),
        filtered AS (
          SELECT
            t.${quotedId} AS _feature_id,
            ${geomExpr} AS geometry,
            ${propsExpr} AS properties
          FROM matched t
          ${orderByClause}
          LIMIT ${limitParam} OFFSET ${offsetParam}
        ),`
        : `
        WITH filtered AS (
          SELECT
            t.${quotedId} AS _feature_id,
            ${geomExpr} AS geometry,
            ${propsExpr} AS properties
          FROM ${quotedTable} t
          ${whereSql}
          ${orderByClause}
          LIMIT ${limitParam} OFFSET ${offsetParam}
        ),`

      const query = `
        ${filteredCte}
        features AS (
          SELECT jsonb_build_object(
            'type', 'Feature',
            'id', _feature_id,
            'geometry', geometry,
            'properties', properties
          ) AS feature
          FROM filtered
        )
        SELECT jsonb_build_object(
          'type', 'FeatureCollection',
          'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
        ) AS jsonb_build_object
        FROM features;
      `

      const result = await this.db.oneOrNone(query, queryParams)
      return result ? result.jsonb_build_object : null
    } catch (error) {
      if (error instanceof ValidationError) throw error
      if (error && CLIENT_SQLSTATE_CODES.has(error.code)) {
        throw new ValidationError(`Invalid query: ${error.message}`, {
          table: values,
          pgCode: error.code
        })
      }

      const dbError = new DatabaseError(
        'Failed to create GeoJSON from PostGIS data',
        error,
        { id, geom, srid, table: values, limit, offset }
      )

      log.error('Error in createGeoJson', error, { id, geom, srid, table: values, limit, offset })
      throw dbError
    }
  }
}

module.exports = DataRepository
