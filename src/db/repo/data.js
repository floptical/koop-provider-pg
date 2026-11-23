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

  async createGeoJson (id, geom, srid, values, limit, offset, queryOptions = {}) {
    try {
      const { whereSql = '', orderBySql = '', params = [] } = queryOptions
      const quotedId = quoteIdentifier(id, 'id')
      const quotedGeom = quoteIdentifier(geom, 'geometry column')
      const quotedTable = formatTableName(values)
      const effectiveOrderBy = orderBySql || `t.${quotedId} ASC`

      // GeoJSON (RFC 7946) and Koop expect WGS84 (EPSG:4326) coordinates
      const geomExpr = Number(srid) === 4326
        ? `ST_AsGeoJSON(t.${quotedGeom})::jsonb`
        : `ST_AsGeoJSON(ST_Transform(t.${quotedGeom}, 4326))::jsonb`

      const queryParams = [...params]
      const geomNameParam = `$${queryParams.length + 1}`
      queryParams.push(geom)
      const limitParam = `$${queryParams.length + 1}`
      queryParams.push(limit)
      const offsetParam = `$${queryParams.length + 1}`
      queryParams.push(offset)

      const query = `
        WITH filtered AS (
          SELECT
            t.${quotedId} AS _feature_id,
            ${geomExpr} AS geometry,
            to_jsonb(t) - ${geomNameParam} AS properties
          FROM ${quotedTable} t
          ${whereSql}
          ORDER BY ${effectiveOrderBy}
          LIMIT ${limitParam} OFFSET ${offsetParam}
        ),
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
