const DataRepository = require('../src/db/repo/data')
const { DatabaseError, ValidationError } = require('../src/utils/errors')

// Mock dependencies
jest.mock('../src/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}))

jest.mock('../src/db/sql', () => ({
  table: {
    getGeometryColumnName: 'SELECT * FROM geometry_columns WHERE...',
    createGeoJson: 'SELECT jsonb_build_object(...)'
  }
}))

describe('DataRepository Error Handling', () => {
  let repository
  let mockDb
  let mockPgp

  beforeEach(() => {
    mockDb = {
      oneOrNone: jest.fn(),
      one: jest.fn()
    }
    mockPgp = {}
    repository = new DataRepository(mockDb, mockPgp)
    jest.clearAllMocks()
  })

  describe('getGeometryColumnName', () => {
    test('should return geometry column info successfully', async () => {
      const expectedResult = {
        f_geometry_column: 'geom',
        srid: 4326
      }
      mockDb.oneOrNone.mockResolvedValue(expectedResult)

      const result = await repository.getGeometryColumnName('public', 'test_table')

      expect(result).toEqual(expectedResult)
      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        expect.any(String),
        { schema: 'public', table: 'test_table' }
      )
    })

    test('should wrap database errors as DatabaseError', async () => {
      const dbError = new Error('Connection failed')
      mockDb.oneOrNone.mockRejectedValue(dbError)

      await expect(repository.getGeometryColumnName('public', 'test_table'))
        .rejects.toThrow(DatabaseError)

      try {
        await repository.getGeometryColumnName('public', 'test_table')
      } catch (error) {
        expect(error.message).toBe('Failed to query geometry column information')
        expect(error.originalError).toBe(dbError)
        expect(error.details).toEqual({
          schema: 'public',
          table: 'test_table'
        })
        expect(error.statusCode).toBe(500)
      }
    })

    test('should handle null results', async () => {
      mockDb.oneOrNone.mockResolvedValue(null)

      const result = await repository.getGeometryColumnName('public', 'missing_table')

      expect(result).toBeNull()
    })

    test('should cache valid geometry column metadata across calls', async () => {
      const expectedResult = { f_geometry_column: 'shape', srid: 2272 }
      mockDb.oneOrNone.mockResolvedValueOnce(expectedResult)

      const first = await repository.getGeometryColumnName('public', 'dor_parcel')
      const second = await repository.getGeometryColumnName('public', 'dor_parcel')

      expect(first).toEqual(expectedResult)
      expect(second).toEqual(expectedResult)
      expect(mockDb.oneOrNone).toHaveBeenCalledTimes(1)
    })
  })

  describe('createGeoJson', () => {
    test('should return GeoJSON successfully', async () => {
      const expectedGeoJson = {
        type: 'FeatureCollection',
        features: []
      }
      mockDb.oneOrNone.mockResolvedValue({
        jsonb_build_object: expectedGeoJson
      })

      const result = await repository.createGeoJson(
        'gid', 'geom', 4326, 'public.test_table', 1000, 0
      )

      expect(result).toEqual(expectedGeoJson)
      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        expect.stringContaining('FROM "public"."test_table" t'),
        ['geom', 1000, 0]
      )
    })

    test('should wrap database errors as DatabaseError', async () => {
      const dbError = new Error('Query execution failed')
      mockDb.oneOrNone.mockRejectedValue(dbError)

      await expect(repository.createGeoJson(
        'gid', 'geom', 4326, 'public.test_table', 1000, 0
      )).rejects.toThrow(DatabaseError)

      try {
        await repository.createGeoJson('gid', 'geom', 4326, 'public.test_table', 1000, 0)
      } catch (error) {
        expect(error.message).toBe('Failed to create GeoJSON from PostGIS data')
        expect(error.originalError).toBe(dbError)
        expect(error.details).toEqual({
          id: 'gid',
          geom: 'geom',
          srid: 4326,
          table: 'public.test_table',
          limit: 1000,
          offset: 0
        })
        expect(error.statusCode).toBe(500)
      }
    })

    test('should handle various parameter types and where pushdown', async () => {
      mockDb.oneOrNone.mockResolvedValue({ jsonb_build_object: {} })

      await repository.createGeoJson('id', 'the_geom', 3857, 'schema.table', 5000, 100, {
        whereSql: 'WHERE t."status" = $1',
        orderBySql: 't."id" DESC',
        params: ['ACTIVE']
      })

      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        expect.stringContaining('WHERE t."status" = $1'),
        ['ACTIVE', 'the_geom', 5000, 100]
      )
    })

    test('should surface undefined_column (42703) as ValidationError (400)', async () => {
      const pgError = Object.assign(new Error('column t.S does not exist'), { code: '42703' })
      mockDb.oneOrNone.mockRejectedValue(pgError)

      await expect(repository.createGeoJson(
        'objectid', 'shape', 2272, 'public.dor_parcel', 10, 0
      )).rejects.toThrow(ValidationError)

      try {
        await repository.createGeoJson('objectid', 'shape', 2272, 'public.dor_parcel', 10, 0)
      } catch (error) {
        expect(error.statusCode).toBe(400)
        expect(error.message).toBe('Invalid query: column t.S does not exist')
        expect(error.details.pgCode).toBe('42703')
      }
    })

    test('getCount should return integer count', async () => {
      mockDb.one.mockResolvedValue({ count: 42 })

      const count = await repository.getCount('public.test_table', 'WHERE t."zip" = $1', ['19103'])

      expect(count).toBe(42)
      expect(mockDb.one).toHaveBeenCalledWith(
        'SELECT COUNT(*)::int AS count FROM "public"."test_table" t WHERE t."zip" = $1;',
        ['19103']
      )
    })

    test('getCount should use pg_class.reltuples for unfiltered counts on large tables', async () => {
      mockDb.oneOrNone.mockResolvedValueOnce({ count: '5182058' })

      const count = await repository.getCount('public.rtt_summary', '', [])

      expect(count).toBe(5182058)
      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        expect.stringContaining('pg_class'),
        ['public', 'rtt_summary']
      )
      expect(mockDb.one).not.toHaveBeenCalled()
    })

    test('getCount should fall back to exact COUNT(*) when pg_class returns null (small table or view)', async () => {
      mockDb.oneOrNone.mockResolvedValueOnce(null)
      mockDb.one.mockResolvedValueOnce({ count: 350 })

      const count = await repository.getCount('public.small_table', '', [])

      expect(count).toBe(350)
      expect(mockDb.one).toHaveBeenCalledWith(
        'SELECT COUNT(*)::int AS count FROM "public"."small_table" t ;',
        []
      )
    })

    test('should push down outFields using jsonb_build_object and support materializeFilter', async () => {
      mockDb.oneOrNone.mockResolvedValue({ jsonb_build_object: { type: 'FeatureCollection', features: [] } })

      await repository.createGeoJson('objectid', 'shape', 2272, 'public.rtt_summary', 2000, 0, {
        whereSql: 'WHERE ST_Intersects(t."shape", ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, $5), $6))',
        orderBySql: 't."objectid" ASC',
        params: [-8368325, 4858337, -8367714, 4858949, 3857, 2272],
        outFields: ['objectid'],
        materializeFilter: true
      })

      const [sql, params] = mockDb.oneOrNone.mock.calls[0]
      expect(sql).toContain('WITH matched AS MATERIALIZED')
      expect(sql).toContain("jsonb_build_object('objectid', t.\"objectid\") AS properties")
      expect(sql).not.toContain('to_jsonb(t)')
      expect(params).toEqual([-8368325, 4858337, -8367714, 4858949, 3857, 2272, 2000, 0])
    })

    test('should support single-pass abortOnExceedLimit CTE for tile queries', async () => {
      mockDb.oneOrNone.mockResolvedValue({
        jsonb_build_object: {
          type: 'FeatureCollection',
          features: [],
          _exceededTransferLimit: true
        }
      })

      const result = await repository.createGeoJson('objectid', 'shape', 2272, 'public.rtt_summary', 2000, 0, {
        whereSql: 'WHERE ST_Intersects(t."shape", ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, $5), $6))',
        orderBySql: 't."objectid" ASC',
        params: [-8368325, 4858337, -8367714, 4858949, 3857, 2272],
        outFields: ['objectid'],
        abortOnExceedLimit: true
      })

      const [sql, params] = mockDb.oneOrNone.mock.calls[0]
      expect(sql).toContain('WITH matched AS MATERIALIZED')
      expect(sql).toContain('overflow AS')
      expect(sql).toContain('WHERE NOT (SELECT exceeded FROM overflow)')
      expect(sql).toContain("'_exceededTransferLimit'")
      expect(params).toEqual([-8368325, 4858337, -8367714, 4858949, 3857, 2272, 2000, 0, 2001])
      expect(result._exceededTransferLimit).toBe(true)
    })

    test('hasMoreThan should check OFFSET limit LIMIT 1', async () => {
      mockDb.oneOrNone.mockResolvedValueOnce({ hit: 1 })
      const exceeded = await repository.hasMoreThan('public.rtt_summary', 'WHERE t."zip" = $1', ['19103'], 2000)
      expect(exceeded).toBe(true)
      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        'SELECT 1 AS hit FROM "public"."rtt_summary" t WHERE t."zip" = $1 OFFSET $2 LIMIT 1;',
        ['19103', 2000]
      )
    })
  })

  describe('getExtent', () => {
    test('should return WGS84 extent from ST_EstimatedExtent when available', async () => {
      mockDb.oneOrNone.mockResolvedValueOnce({
        xmin: -75.28,
        ymin: 39.86,
        xmax: -74.95,
        ymax: 40.14
      })

      const extent = await repository.getExtent('public', 'dor_parcel', 'shape', 2272)

      expect(extent).toEqual({
        xmin: -75.28,
        ymin: 39.86,
        xmax: -74.95,
        ymax: 40.14,
        spatialReference: { wkid: 4326, latestWkid: 4326 }
      })
      expect(mockDb.oneOrNone).toHaveBeenCalledTimes(1)
      expect(mockDb.oneOrNone).toHaveBeenCalledWith(
        expect.stringContaining('ST_EstimatedExtent($1, $2, $3)'),
        ['public', 'dor_parcel', 'shape', 2272]
      )
    })

    test('should fall back to ST_Extent when ST_EstimatedExtent fails', async () => {
      mockDb.oneOrNone
        .mockRejectedValueOnce(new Error('stats for "dor_parcel.shape" do not exist'))
        .mockResolvedValueOnce({
          xmin: -75.27,
          ymin: 39.88,
          xmax: -74.96,
          ymax: 40.13
        })

      const extent = await repository.getExtent('public', 'dor_parcel', 'shape', 2272)

      expect(extent).toEqual({
        xmin: -75.27,
        ymin: 39.88,
        xmax: -74.96,
        ymax: 40.13,
        spatialReference: { wkid: 4326, latestWkid: 4326 }
      })
      expect(mockDb.oneOrNone).toHaveBeenCalledTimes(2)
      expect(mockDb.oneOrNone).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('ST_Extent(t."shape")'),
        [2272]
      )
    })

    test('should return null if both extent queries fail', async () => {
      mockDb.oneOrNone
        .mockRejectedValueOnce(new Error('estimated failed'))
        .mockRejectedValueOnce(new Error('exact failed'))

      const extent = await repository.getExtent('public', 'dor_parcel', 'shape', 2272)

      expect(extent).toBeNull()
    })
  })

  describe('constructor', () => {
    test('should initialize with db and pgp instances', () => {
      const repo = new DataRepository(mockDb, mockPgp)

      expect(repo.db).toBe(mockDb)
      expect(repo.pgp).toBe(mockPgp)
    })
  })
})