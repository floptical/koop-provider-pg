const Model = require('../src/model')
const { ValidationError, DatabaseError } = require('../src/utils/errors')

// Mock dependencies
jest.mock('../src/db', () => ({
  db: {
    data: {
      getGeometryColumnName: jest.fn(),
      createGeoJson: jest.fn(),
      getCount: jest.fn(),
      getExtent: jest.fn(),
      hasMoreThan: jest.fn()
    }
  }
}))

jest.mock('../src/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  }))
}))

const { db } = require('../src/db')

describe('Model Error Handling', () => {
  let model
  let mockCallback

  beforeEach(() => {
    model = new Model()
    mockCallback = jest.fn()
    jest.clearAllMocks()
  })

  describe('getData validation', () => {
    test('should throw ValidationError for invalid id format', async () => {
      const req = { params: { id: 'invalid' } }

      await model.getData(req, mockCallback)

      expect(mockCallback).toHaveBeenCalledWith(
        expect.any(ValidationError)
      )

      const error = mockCallback.mock.calls[0][0]
      expect(error.message).toBe('The "id" parameter must be in the form of "schema.table"')
      expect(error.details.providedId).toBe('invalid')
      expect(error.details.schema).toBe('invalid')
      expect(error.statusCode).toBe(400)
    })

    test('should handle missing geometry column gracefully', async () => {
      const req = { params: { id: 'schema.table' } }
      db.data.getGeometryColumnName.mockResolvedValue(null)

      await model.getData(req, mockCallback)

      expect(mockCallback).toHaveBeenCalledWith(null, {
        type: 'FeatureCollection',
        features: [],
        metadata: {
          title: 'schema',
          name: 'schema.table',
          description: 'This table does not contain spatial data.',
          geometryType: null
        }
      })
    })

    test('should handle incomplete geometry column metadata', async () => {
      const req = { params: { id: 'schema.table' } }
      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'geom',
        srid: null // missing srid
      })

      await model.getData(req, mockCallback)

      expect(mockCallback).toHaveBeenCalledWith(null, expect.objectContaining({
        type: 'FeatureCollection',
        features: []
      }))
    })
  })

  describe('getData database errors', () => {
    test('should wrap database errors as DatabaseError', (done) => {
      const req = { params: { id: 'schema.table' } }
      const dbError = new Error('Connection failed')
      db.data.getGeometryColumnName.mockRejectedValue(dbError)

      const callback = (error, result) => {
        try {
          expect(error).toBeInstanceOf(DatabaseError)
          expect(error.message).toBe('Failed to retrieve data from PostGIS')
          expect(error.originalError).toBe(dbError)
          expect(error.details).toEqual({
            schema: 'schema',
            table: 'table',
            id: 'gid'
          })
          expect(error.statusCode).toBe(500)
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })

    test('should handle createGeoJson database errors', (done) => {
      const req = { params: { id: 'schema.table' } }
      const dbError = new Error('Query failed')
      
      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'geom',
        srid: 4326
      })
      db.data.createGeoJson.mockRejectedValue(dbError)

      const callback = (error, result) => {
        try {
          expect(error).toBeInstanceOf(DatabaseError)
          expect(error.originalError).toBe(dbError)
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })

    test('should handle unexpected GeoJSON result', (done) => {
      const req = { params: { id: 'schema.table' } }
      
      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'geom',
        srid: 4326
      })
      db.data.createGeoJson.mockResolvedValue(null) // unexpected result

      const callback = (error, result) => {
        try {
          expect(error).toBeNull()
          expect(result).toEqual(expect.objectContaining({
            type: 'FeatureCollection',
            features: [],
            metadata: expect.objectContaining({
              description: 'no-data'
            })
          }))
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })
  })

  describe('successful getData', () => {
    test('should return valid GeoJSON with metadata', (done) => {
      const req = { params: { id: 'schema.table' } }
      const mockGeojson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { id: 1 }
          }
        ]
      }
      
      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'geom',
        srid: 4326
      })
      db.data.createGeoJson.mockResolvedValue(mockGeojson)

      const callback = (error, result) => {
        try {
          expect(error).toBeNull()
          expect(result).toEqual(expect.objectContaining({
            type: 'FeatureCollection',
            features: mockGeojson.features,
            description: 'PG Koop Feature Service',
            metadata: expect.objectContaining({
              title: 'schema',
              name: 'schema.table',
              idField: 'gid',
              geometryType: 'Point'
            })
          }))
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })

    test('should attach PostGIS table extent to metadata on metadata requests', (done) => {
      const req = { params: { id: 'public.dor_parcel', layer: '0' }, query: {} }
      const mockExtent = {
        xmin: -75.28,
        ymin: 39.86,
        xmax: -74.95,
        ymax: 40.14,
        spatialReference: { wkid: 4326, latestWkid: 4326 }
      }
      const mockGeojson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [] },
            properties: { objectid: 1 }
          }
        ]
      }

      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'shape',
        srid: 2272
      })
      db.data.createGeoJson.mockResolvedValue(mockGeojson)
      db.data.getExtent.mockResolvedValue(mockExtent)

      const callback = (error, result) => {
        try {
          expect(error).toBeNull()
          expect(db.data.getExtent).toHaveBeenCalledWith('public', 'dor_parcel', 'shape', 2272)
          expect(result.metadata.extent).toEqual(mockExtent)
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })

    test('should use single-pass abortOnExceedLimit when returnExceededLimitFeatures=false', (done) => {
      const req = {
        path: '/pg/rest/services/public.rtt_summary/FeatureServer/0/query',
        params: { id: 'public.rtt_summary', layer: '0' },
        query: {
          where: '1=1',
          geometry: '-75.2,39.9,-75.1,40.0',
          outFields: 'objectid',
          returnExceededLimitFeatures: 'false'
        }
      }

      db.data.getGeometryColumnName.mockResolvedValue({
        f_geometry_column: 'shape',
        srid: 2272
      })
      db.data.createGeoJson.mockResolvedValue({
        type: 'FeatureCollection',
        features: [],
        _exceededTransferLimit: true
      })

      const callback = (error, result) => {
        try {
          expect(error).toBeNull()
          expect(db.data.createGeoJson).toHaveBeenCalledWith(
            'gid',
            'shape',
            2272,
            'public.rtt_summary',
            2000,
            0,
            expect.objectContaining({
              outFields: ['gid', 'objectid'],
              abortOnExceedLimit: true
            })
          )
          expect(result.features).toEqual([])
          expect(result._exceededTransferLimit).toBeUndefined()
          expect(result.metadata.exceededTransferLimit).toBe(true)
          done()
        } catch (e) {
          done(e)
        }
      }

      model.getData(req, callback)
    })
  })
})