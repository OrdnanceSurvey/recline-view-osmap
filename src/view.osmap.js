/*jshint multistr:true */

this.recline = this.recline || {};
this.recline.View = this.recline.View || {};

(function ($, my) {

// ## Map view for a Dataset containing Ordnance Survey Easting/Northing coords using
// Openlayers mapping library.
//
// This view allows to plot OSGB36 gereferenced records on a map. The location
// information can be provided in 2 ways:
//
// 1. Via a single field. This field must be either a geo_point or
// [GeoJSON](http://geojson.org) object
// 2. Via two fields with easting and northing coordinates.
//
// Which fields in the data these correspond to can be configured via the state
// (and are guessed if no info is provided).
  my.OSMap = Backbone.View.extend({

    // These are the default (case-insensitive) names of field that are used if found.
    // If not found, the user will need to define the fields via the editor.
    eastingFieldNames:['easting', 'east', 'x'],
    northingFieldNames:['northing', 'north', 'y'],
    geometryFieldNames:['geojson', 'geom', 'the_geom', 'geometry', 'spatial', 'location', 'geo', 'lonlat'],

    // ## Creates a new OSMap view
    //
    // The state options that are accepted by this view are:
    //
    // 1. 'geomField' : the name of the geometry field in the data containing GeoJSON, If not set, will be derived if possible
    // 2. 'eastingField' : the name of the field containing the 'easting' value. If not set, will be derived if possible
    // 3. 'northingField' : the name of the field containing the 'northing' value. If not set, will be derived if possible
    // 4. 'autoZoom' : if true (the default), will zoom to contain all the data points
    // 5. 'oskey' : the Ordnance Survey Openspace key - if not set, will cause an exception to be thrown
    // 6. 'osstack' : the map stack to be used, one of OSF (default), OSP, OSCS
    // 7. 'withPanZoomBar' : boolean indicating if the Pan And Zoom bar should be drawn
    // 8. 'theme' : the theme path which contains imagery etc for controls and popups, default is 'vendor/openlayers/theme/dark/'
    //
    // ### Map Stacks
    //
    // There are three main map stacks available to applications, one free and two paid for. Details of the different
    // stacks can be found at the OS website:
    //
    // Openspace: http://www.ordnancesurvey.co.uk/oswebsite/web-services/os-openspace/api/index.html
    // Openspace Pro: http://www.ordnancesurvey.co.uk/oswebsite/web-services/os-openspace/pro/index.html
    //
    // When creating the map stack, the following 'enum' values can be used for the stack type:
    //
    // OSF: Openspace free (the default)
    // OSP: Openspace Pro
    // OSCS: Openspace Pro Consistently Styled
    initialize:function (options) {

      var self = this;

      this.el = $(this.el);
      this.visible = true;
      this.mapReady = false;
      this.map = null;
      this.buffer = null;

      var stateData = _.extend({
          geomField:null,
          eastingField:null,
          northingField:null,
          autoZoom:true,
          osstack: 'OSF',
          withPanZoomBar: false,
          theme: 'vendor/openlayers/theme/dark/'  // note that trailing slash is important
        },
        options.state
      );
      this.state = new recline.Model.ObjectState(stateData);

      // Listen to changes in the fields
      this.model.fields.bind('change', function() {
        self._setupGeometryField();
        self.render();
      });

      // Listen to changes in the records
      this.model.records.bind('add', function(doc){self.redraw('add',doc);});
      this.model.records.bind('change', function(doc){
        self.redraw('remove',doc);
        self.redraw('add',doc);
      });
      this.model.records.bind('remove', function(doc){self.redraw('remove',doc);});
      this.model.records.bind('reset', function(){self.redraw('reset');});

      this.menu = new my.OSMapMenu({
        model: this.model,
        state: this.state.toJSON()
      });

      this.menu.state.bind('change', function() {
        self.state.set(self.menu.state.toJSON());
        self.redraw();
      });

      this.state.bind('change', function() {
        self.redraw();
      });

      this.elSidebar = this.menu.el;

    },

    // ## Customization Functions
    //
    // The following methods are designed for overriding in order to customize
    // behaviour

    // ### infobox
    //
    // Function to create infoboxes used in popups. The default behaviour is very simple and just lists all attributes.
    //
    // Users should override this function to customize behaviour i.e.
    //
    //     view = new View({...});
    //     view.infobox = function(record) {
    //       ...
    //     }
    infobox:function (record) {
      var html = '';
      for (var key in record.attributes) {
        if (!(this.state.get('geomField') && key == this.state.get('geomField'))) {
          html += '<div><strong>' + key + '</strong>: ' + record.attributes[key] + '</div>';
        }
      }
      return html;
    },


    // END: Customization section
    // ----

    // ### Public: Adds the necessary elements to the page.
    //
    // Also sets up the editor fields and the map if necessary.
    render:function () {

      if (this.state.get('oskey') === undefined) {
        throw "OS Key not specified on options: please ensure 'options.state.oskey' is set";
      }

      var self = this;

      // holds the .recline-osmap
      this.$el.html('<div class="recline-osmap"></div>');
      this.$target = this.$el.find('.recline-osmap');

      // holds the .panel .osmap
      // we place this element off site so that OL can calculate widths etc

      this.$map = $('<div class="panel osmap"></div>');

      this.$map.css({
        position: 'absolute',
        left: -10000
      });

      // setup the map offsite - this allows OL to calculate widths and heights
      // and prevents it throwing a wobbly
      $('body').append(this.$map);

      this.redraw();

      return this;
    },

    // ### Public: Redraws the features on the map according to the action provided
    //
    // Actions can be:
    //
    // * reset: Clear all features
    // * add: Add one or n features (records)
    // * remove: Remove one or n features (records)
    // * refresh: Clear existing features and add all current records
    redraw:function (action, doc) {
      var self = this;
      action = action || 'refresh';
      // try to set things up if not already
      if (!self._geomReady()) {
        self._setupGeometryField();
      }
      if (!self.mapReady) {
        self._setupMap();
      }

      if (this._geomReady() && this.mapReady) {

        if (action == 'refresh' || action == 'reset') {
          this.vectors.removeAllFeatures({silent: true});
          this._add(this.model.records.models);
        } else if (action == 'add' && doc) {
          this._add(doc);
        } else if (action == 'remove' && doc) {
          this._remove(doc);
        }

        if (this.state.get('autoZoom')){
          if (this.visible){
            this._zoomToFeatures();
          } else {
            this._zoomPending = true;
          }
        }

      }

    },

    show:function () {
      if (this.map) {
        this.$map.appendTo(this.$target);

        this.$map.css({
          position: 'relative',
          left: 0
        });

        this.map.updateSize();
        for (var idx = 0; idx < this.map.layers.length; idx++) {
          this.map.layers[idx].redraw();
        }
        if (this.state.get('autoZoom')) {
          this._zoomToFeatures();
        } else {
          this.map.zoomTo(1);
        }
      }
      this.visible = true;
    },

    hide:function () {
      if (this.map) {
        this.$map.css({
          position: 'absolute',
          left: -10000
        });
        this.$map.appendTo($('body'));
      }
      this.visible = false;
    },

    _geomReady:function () {
      return Boolean(this.state.get('geomField') || (this.state.get('northingField') && this.state.get('eastingField')));
    },

    // Private: Add one or n features to the map
    //
    // For each record passed, a GeoJSON geometry will be extracted and added
    // to the features layer. If an exception is thrown, the process will be
    // stopped and an error notification shown.
    //
    // Each feature will have a popup associated with all the record fields.
    //
    _add:function (docs) {
      var self = this;

      if (!(docs instanceof Array)) docs = [docs];

      _.every(docs, function (doc) {
        var feature = self._getGeometryFromRecord(doc);

        if (typeof feature === 'undefined' || feature === null) {
          // Empty field
          return true;
        }

        self.vectors.addFeatures(feature);
        return true;
      });
    },

    // Private: Remove one or n features from the map
    //
    _remove:function (docs) {

      var self = this;

      if (!(docs instanceof Array)) docs = [docs];

      var toRemove = [];
      _.each(docs, function (doc) {

        _.each(self.vectors.features, function(feature) {
          if (feature.properties.cid == doc.cid) {
            toRemove.push(feature);
          }
        });
      });

      if (toRemove.length > 0) {
        self.vectors.removeFeatures(toRemove, {silent: true});
      }
    },

    // Extracts a Vector
    _getGeometryFromRecord:function (doc) {

      var e,n;

      if (this.state.get('geomField')) {

        var value = doc.get(this.state.get('geomField'));

        if (typeof(value) === 'string') {

          var parsed;
          try {
            parsed = this.formatter.read(value);
          } catch (e) {
          }

          if (parsed !== undefined &&
              parsed instanceof Array &&
              parsed.length > 0 &&
              parsed[0] instanceof OpenLayers.Feature.Vector) {

            // in the case of an array of vectors, we bind the popup details to each
            // instance, for simpler cases, this is handled by the _toVectorArray function
            for (var idx = 0; idx < parsed.length; idx++) {
              if (!(parsed[idx] instanceof OpenLayers.Feature.Vector)) {
                continue;
              }

              parsed[idx].properties = {
                popupContent: self.infobox(doc),
                cid: doc.cid
              }
            }
            return parsed;
          }

        }

        if (typeof(value) === 'string') {
          value = value.replace('(', '').replace(')', '');
          var parts = value.split(',');

          if (parts === undefined || parts.length < 2) {
            return null;
          }

          e = parseFloat(parts[0]);
          n = parseFloat(parts[1]);

          if (!isNaN(e) && !isNaN(n)) {
            return this._toVectorArray(doc, e, n);
          }

          return null;

        }

        if (value && _.isArray(value)) {
          // [ x, y ]
          return this._toVectorArray(doc, value[0], value[1]);

        }
        // We o/w assume that contents of the field are a valid GeoJSON object
        return value;
      }

      if (this.state.get('eastingField') && this.state.get('northingField')) {
        // We'll create a GeoJSON like point object from the two lat/lon fields
        e = doc.get(this.state.get('eastingField'));
        n = doc.get(this.state.get('northingField'));

        if (!isNaN(parseFloat(e)) && !isNaN(parseFloat(n))) {
          return this._toVectorArray(doc, e, n);
        }
      }

      return null;
    },

    // Private: converts a single coord into a Vector array that can be displayed on an
    // OpenLayers map

    _toVectorArray:function(doc, x, y) {
      var self = this;
      var vector = new OpenLayers.Feature.Vector(this.formatter.read({
        "type":"Point",
        "coordinates":[x, y]
      }, 'Geometry'));
      vector.properties = {
        popupContent: self.infobox(doc),
        // Add a reference to the model id, which will allow us to
        // link this Leaflet layer to a Recline doc
        cid: doc.cid
      };

      return [vector];
    },

    // Private: Check if there is a field with GeoJSON geometries or alternatively,
    // two fields with lat/lon values.
    //
    // If not found, the user can define them via the UI form.
    _setupGeometryField:function () {
      // should not overwrite if we have already set this (e.g. explicitly via state)
      if (!this._geomReady()) {
        this.state.set({
          geomField:this._checkField(this.geometryFieldNames),
          eastingField:this._checkField(this.eastingFieldNames),
          northingField:this._checkField(this.northingFieldNames)
        });
        //this.menu.state.set(this.state.toJSON());
      }
    },

    // Private: Check if a field in the current model exists in the provided
    // list of names.
    //
    //
    _checkField:function (fieldNames) {
      var field;
      var modelFieldNames = this.model.fields.pluck('id');
      for (var i = 0; i < fieldNames.length; i++) {
        for (var j = 0; j < modelFieldNames.length; j++) {
          if (modelFieldNames[j].toLowerCase() == fieldNames[i].toLowerCase())
            return modelFieldNames[j];
        }
      }
      return null;
    },

    // Private: Zoom to map to current features extent if any, or to the full
    // extent if none.
    //
    _zoomToFeatures:function () {
      this.map.zoomToExtent(this.vectors.getDataExtent());
    },

    // Private: Sets up the OpenLayers map control and the features layer.
    //
    _setupMap:function () {
      var self = this;

      OpenLayers.ImgPath = this.state.get('theme');

      var controls = [
        new OpenLayers.Control.DragPan(),
        new OpenLayers.Control.Navigation(),
        new OpenLayers.Control.Attribution()
      ];

      if (this.state.get('withPanZoomBar') === true) {
        controls.push(new OpenLayers.Control.PanZoomBar({
          position:new OpenLayers.Pixel(10, 30)
        }));
      }

      var mapType = self.state.get('osstack');

      var style;

      if (mapType === 'OSCS') {
        this.map = this._buildOSCS();
        style = new OpenLayers.StyleMap(new OpenLayers.Style({
          pointRadius: 6,
          fillColor: '#c2b396',
          strokeColor: '#222222'
        }));
      } else if (mapType === 'OSP') {
        this.map = this._buildOSP();
        style = new OpenLayers.StyleMap(new OpenLayers.Style({
          pointRadius: 6,
          fillColor: '#007fff',
          strokeColor: '#222222'
        }));
      } else {
        this.map = this._buildOSF();
        style = new OpenLayers.StyleMap(new OpenLayers.Style({
          pointRadius: 6,
          fillColor: '#007fff',
          strokeColor: '#222222'
        }));
      }

      // Popup with Leaflet marker
      /*
      var style = new OpenLayers.StyleMap(new OpenLayers.Style({
        pointRadius: 10,
        externalGraphic: 'http://leafletjs.com/dist/images/marker-icon.png',
        graphicWidth: 25,
        graphicHeight: 41,
        graphicYOffset: -41,
        graphicOpacity: 1
      }));
      */

      var vectors = new OpenLayers.Layer.Vector('Markers', {
        styleMap: style
      });
      vectors.setVisibility(true);

      this.map.addLayer(vectors);

      this.selectControl = new OpenLayers.Control.SelectFeature(
        vectors,
        {
          onSelect: onFeatureSelect,
          onUnselect: onFeatureUnselect,
          autoActivate: true
        }
      );


      function onFeatureSelect(feature) {
        var selectedFeature = feature;
        var popup = new OpenLayers.Popup.FramedCloud("chicken",
          feature.geometry.getBounds().getCenterLonLat(),
          null,
          feature.properties.popupContent,
          null,
          true,
          function(evt) {
            self.selectControl.unselect(selectedFeature);
          });
        feature.popup = popup;
        self.map.addPopup(popup);
      }

      function onFeatureUnselect(feature) {
        self.map.removePopup(feature.popup);
        feature.popup.destroy();
        feature.popup = null;
      }

      controls.push(this.selectControl);

      this.map.addControls(controls);

      // the following references are used for quick access when reseting/refreshing the
      // views
      this.vectors = vectors;
      this.formatter = new OpenLayers.Format.GeoJSON();

      this.mapReady = true;
    },

    _buildOSP: function() {
      var self = this;

      var products = [
        {name:"OV0", res: 2500, size:new OpenLayers.Size(200, 200)},
        {name:"OV1", res: 1000, size:new OpenLayers.Size(200, 200)},
        {name:"OV2", res: 500, size:new OpenLayers.Size(200, 200)},
        {name:"MSR", res: 200, size:new OpenLayers.Size(200, 200)},
        {name:"MS", res: 100, size:new OpenLayers.Size(200, 200)},
        {name:"250KR", res: 50, size:new OpenLayers.Size(200, 200)},
        {name:"250K", res: 25, size:new OpenLayers.Size(200, 200)},
        {name:"50KR", res: 10, size:new OpenLayers.Size(200, 200)},
        {name:"25KR", res: 4, size:new OpenLayers.Size(250, 250)},
        {name:"25K", res: 2.5, size:new OpenLayers.Size(200, 200)},
        {name:"VML", res: 1, size:new OpenLayers.Size(250, 250)}
      ];

      var resolutions = [2500, 1000, 500, 200, 100, 50, 25, 10, 4, 2.5, 1];

      var extent = new OpenLayers.Bounds(0, 0, 700000, 1300000);

      var map = new OpenLayers.Map(this.$map.get(0), {
        theme:null,
        maxExtent:extent,
        resolutions:resolutions,
        units:'m',
        projection:"EPSG:27700",
        restrictedExtent:extent,
        controls: []
      });

      var moveTo = function (bounds, zoomChanged, dragging) {
        if (zoomChanged) {

          var zoom = this.map.getZoom();
          var prod = (zoom >= products.length ? products.last() : products[zoom]);
          this.params.LAYERS = this.map.getResolution();
          this.params.PRODUCT = prod.name;
          var oTileSize = this.tileSize;
          this.setTileSize(prod.size);
          if (this.tileSize != oTileSize) {
            this.clearGrid();
          }

        }
        OpenLayers.Layer.Grid.prototype.moveTo.apply(this, arguments);
      };

      var oswms = new OpenLayers.Layer.WMS("OpenSpace Pro CS",
        "http://osopenspacepro.ordnancesurvey.co.uk/osmapapi/ts",
        { format:'image/png', key:self.state.get('oskey'), url:window.location.href},
        { buffer:2,
          moveTo:moveTo,
          attribution:'<p>&copy; Crown copyright and database rights 2012<span style="white-space: nowrap;"> Ordnance Survey.</span>  &nbsp;&nbsp;<span style="white-space: nowrap;"><a href="http://openspace.ordnancesurvey.co.uk/openspace/developeragreement.html#enduserlicense" target="_blank">End User Licence Agreement</a></span></p>',
          opacity: 0.7
        }
      );

      oswms.setVisibility(true);

      map.addLayer(oswms);

      return map;
    },

    // Private: builds the OS CS stack
    _buildOSCS: function() {
      var self = this;

      var products = [
        {name:"CS00", res:896, size:new OpenLayers.Size(250, 250)},
        {name:"CS01", res:448, size:new OpenLayers.Size(250, 250)},
        {name:"CS02", res:224, size:new OpenLayers.Size(250, 250)},
        {name:"CS03", res:112, size:new OpenLayers.Size(250, 250)},
        {name:"CS04", res:56, size:new OpenLayers.Size(250, 250)},
        {name:"CS05", res:28, size:new OpenLayers.Size(250, 250)},
        {name:"CS06", res:14, size:new OpenLayers.Size(250, 250)},
        {name:"CS07", res:7, size:new OpenLayers.Size(250, 250)},
        {name:"CS08", res:3.5, size:new OpenLayers.Size(250, 250)},
        {name:"CS09", res:1.75, size:new OpenLayers.Size(250, 250)},
        {name:"CS10", res:0.875, size:new OpenLayers.Size(250, 250)}
      ];

      var resolutions = [896, 448, 224, 112, 56, 28, 14, 7, 3.5, 1.75, 0.875];
      var extent = new OpenLayers.Bounds(0, 0, 700000, 1300000);

      var map = new OpenLayers.Map(this.$map.get(0), {
        theme:null,
        maxExtent:extent,
        resolutions:resolutions,
        units:'m',
        projection:"EPSG:27700",
        restrictedExtent:extent,
        controls: []
      });

      var moveTo = function (bounds, zoomChanged, dragging) {
        if (zoomChanged) {

          var zoom = this.map.getZoom();
          var prod = (zoom >= products.length ? products.last() : products[zoom]);
          this.params.LAYERS = this.map.getResolution();
          this.params.PRODUCT = prod.name;
          var oTileSize = this.tileSize;
          this.setTileSize(prod.size);
          if (this.tileSize != oTileSize) {
            this.clearGrid();
          }

        }
        OpenLayers.Layer.Grid.prototype.moveTo.apply(this, arguments);
      };

      var oswms = new OpenLayers.Layer.WMS("OpenSpace Pro CS",
        "http://osopenspacepro.ordnancesurvey.co.uk/osmapapi/ts",
        { format:'image/png', key:self.state.get('oskey'), url:window.location.href},
        { buffer:2,
          moveTo:moveTo,
          attribution:'<p>&copy; Crown copyright and database rights 2012<span style="white-space: nowrap;"> Ordnance Survey.</span>  &nbsp;&nbsp;<span style="white-space: nowrap;"><a href="http://openspace.ordnancesurvey.co.uk/openspace/developeragreement.html#enduserlicense" target="_blank">End User Licence Agreement</a></span></p>',
          opacity: 0.7
        }
      );

      oswms.setVisibility(true);

      map.addLayer(oswms);

      return map;
    },

    // Private: builds the base Openspace free stack
    _buildOSF: function() {

      var self = this;

      var resolutions = [2500, 1000, 500, 200, 100, 50, 25, 10, 5, 4, 2.5, 2, 1];
      var extent = new OpenLayers.Bounds(0, 0, 700000, 1300000);

      var map = new OpenLayers.Map(this.$map.get(0), {
        theme:null,
        maxExtent:extent,
        resolutions:resolutions,
        units:'m',
        projection:"EPSG:27700",
        restrictedExtent:extent,
        controls: []
      });

      var moveTo = function (bounds, zoomChanged, dragging) {
        if (zoomChanged) {
          var resolution = self.map.getResolution();
          this.params.LAYERS = resolution;
          var oTileSize = this.tileSize;

          // note slight kink here when resolution === 2.5
          this.setTileSize(resolution < 5 && resolution !== 2.5 ? this.tile250 : this.tile200);
          if (this.tileSize != oTileSize)
            this.clearGrid();
        }
        OpenLayers.Layer.Grid.prototype.moveTo.apply(this, arguments);
      };


      var oswms = new OpenLayers.Layer.WMS("OpenSpace",
        "http://openspace.ordnancesurvey.co.uk/osmapapi/ts",
        { format:'image/png', key:self.state.get('oskey'), url:window.location.href},
        { buffer:0,
          moveTo:moveTo,
          tile200:new OpenLayers.Size(200, 200),
          tile250:new OpenLayers.Size(250, 250),
          attribution:'<p>&copy; Crown copyright and database rights 2012<span style="white-space: nowrap;"> Ordnance Survey.</span>  &nbsp;&nbsp;<span style="white-space: nowrap;"><a href="http://openspace.ordnancesurvey.co.uk/openspace/developeragreement.html#enduserlicense" target="_blank">End User Licence Agreement</a></span></p>',
          opacity: 0.7
        }
      );

      oswms.setVisibility(true);

      map.addLayer(oswms);

      return map;
    },

    // Private: Helper function to select an option from a select list
    //
    _selectOption:function (id, value) {
      var options = $('.' + id + ' > select > option');
      if (options) {
        options.each(function (opt) {
          if (this.value == value) {
            $(this).attr('selected', 'selected');
            return false;
          }
        });
      }
    }
  });

  my.OSMapMenu = Backbone.View.extend({
    className:'editor',

    template:' \
    <form class="form-stacked"> \
      <div class="clearfix"> \
        <div class="editor-field-type"> \
            <label class="radio"> \
              <input type="radio" id="editor-field-type-latlon" name="editor-field-type" value="latlon" checked="checked"/> \
              Easting / Northing fields</label> \
            <label class="radio"> \
              <input type="radio" id="editor-field-type-geom" name="editor-field-type" value="geom" /> \
              GeoJSON field</label> \
        </div> \
        <div class="editor-field-type-latlon"> \
          <label>Northing field</label> \
          <div class="input editor-lat-field"> \
            <select> \
            <option value=""></option> \
            {{#fields}} \
            <option value="{{id}}">{{label}}</option> \
            {{/fields}} \
            </select> \
          </div> \
          <label>Easting field</label> \
          <div class="input editor-lon-field"> \
            <select> \
            <option value=""></option> \
            {{#fields}} \
            <option value="{{id}}">{{label}}</option> \
            {{/fields}} \
            </select> \
          </div> \
        </div> \
        <div class="editor-field-type-geom" style="display:none"> \
          <label>Geometry field (GeoJSON)</label> \
          <div class="input editor-geom-field"> \
            <select> \
            <option value=""></option> \
            {{#fields}} \
            <option value="{{id}}">{{label}}</option> \
            {{/fields}} \
            </select> \
          </div> \
        </div> \
      </div> \
      <div class="editor-buttons"> \
        <button class="btn editor-update-map">Update</button> \
      </div> \
      <div class="editor-options" > \
        <label class="checkbox"> \
          <input type="checkbox" id="editor-auto-zoom" value="autozoom" checked="checked" /> \
          Auto zoom to features</label> \
      </div> \
      <input type="hidden" class="editor-id" value="map-1" /> \
      </div> \
    </form> \
  ',

    // Define here events for UI elements
    events:{
      'click .editor-update-map':'onEditorSubmit',
      'change .editor-field-type':'onFieldTypeChange',
      'click #editor-auto-zoom':'onAutoZoomChange'
    },

    initialize:function (options) {
      var self = this;
      this.el = $(this.el);
      _.bindAll(this, 'render');
      this.model.fields.bind('change', this.render);
      this.state = new recline.Model.ObjectState(options.state);
      this.state.bind('change', this.render);
      this.render();
    },

    // ### Public: Adds the necessary elements to the page.
    //
    // Also sets up the editor fields and the map if necessary.
    render:function () {
      var self = this;
      htmls = Mustache.render(this.template, this.model.toTemplateJSON());
      $(this.el).html(htmls);

      if (this._geomReady() && this.model.fields.length) {
        if (this.state.get('geomField')) {
          this._selectOption('editor-geom-field', this.state.get('geomField'));
          this.el.find('#editor-field-type-geom').attr('checked', 'checked').change();
        } else {
          this._selectOption('editor-lon-field', this.state.get('eastingField'));
          this._selectOption('editor-lat-field', this.state.get('northingField'));
          this.el.find('#editor-field-type-latlon').attr('checked', 'checked').change();
        }
      }
      if (this.state.get('autoZoom')) {
        this.el.find('#editor-auto-zoom').attr('checked', 'checked');
      } else {
        this.el.find('#editor-auto-zoom').removeAttr('checked');
      }
      return this;
    },

    _geomReady:function () {
      return Boolean(this.state.get('geomField') || (this.state.get('northingField') && this.state.get('eastingField')));
    },

    // ## UI Event handlers
    //

    // Public: Update map with user options
    //
    // Right now the only configurable option is what field(s) contains the
    // location information.
    //
    onEditorSubmit:function (e) {
      e.preventDefault();
      if (this.el.find('#editor-field-type-geom').attr('checked')) {
        this.state.set({
          geomField:this.el.find('.editor-geom-field > select > option:selected').val(),
          eastingField:null,
          northingField:null
        });
      } else {
        this.state.set({
          geomField:null,
          eastingField:this.el.find('.editor-lon-field > select > option:selected').val(),
          northingField:this.el.find('.editor-lat-field > select > option:selected').val()
        });
      }
      return false;
    },

    // Public: Shows the relevant select lists depending on the location field
    // type selected.
    //
    onFieldTypeChange:function (e) {
      if (e.target.value == 'geom') {
        this.el.find('.editor-field-type-geom').show();
        this.el.find('.editor-field-type-latlon').hide();
      } else {
        this.el.find('.editor-field-type-geom').hide();
        this.el.find('.editor-field-type-latlon').show();
      }
    },

    onAutoZoomChange:function (e) {
      this.state.set({autoZoom:!this.state.get('autoZoom')});
    },

    // Private: Helper function to select an option from a select list
    //
    _selectOption:function (id, value) {
      var options = this.el.find('.' + id + ' > select > option');
      if (options) {
        options.each(function (opt) {
          if (this.value == value) {
            $(this).attr('selected', 'selected');
            return false;
          }
        });
      }
    }
  });

})(jQuery, recline.View);

