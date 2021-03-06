///<reference path="../typings/index.d.ts" />

import * as moment from "moment";

export default class GnocchiDatasource {
    name: string;
    type: string;
    supportMetrics: boolean;
    default_headers: any;
    project: string;
    username: string;
    password: string;
    url: string;
    keystone_endpoint: string;

    /** @ngInject */
    constructor(instanceSettings, private $q, private backendSrv, private templateSrv) {
      var self = this;

      self.type = 'gnocchi';
      self.name = instanceSettings.name;
      self.supportMetrics = true;

      self.default_headers = {
        'Content-Type': 'application/json',
      };

      if (instanceSettings.jsonData) {
        self.project = instanceSettings.jsonData.project;
        self.username = instanceSettings.jsonData.username;
        self.password = instanceSettings.jsonData.password;
        self.default_headers['X-Auth-Token'] = instanceSettings.jsonData.token;
      }

      // If the URL starts with http, we are in direct mode
      if (instanceSettings.url.indexOf('http') === 0){
        self.url = null;
        self.keystone_endpoint = self.sanitize_url(instanceSettings.url);
      } else {
        self.url = self.sanitize_url(instanceSettings.url);
        self.keystone_endpoint = null;
      }
    }

    ////////////////
    // Plugins API
    ////////////////

    query(options: any) {
      var self = this;

      var promises = _.map(options.targets, function(target: any) {
        // Ensure target is valid
        var default_measures_req = {
          url: null,
          data: null,
          method: null,
          params: {
            'aggregation': target.aggregator,
            'start': options.range.from.toISOString(),
            'end': null
          }
        };
        if (options.range.to){
          default_measures_req.params.end = options.range.to.toISOString();
        }

        var error = self.validateTarget(target, true);
        if (error) {
          // no need to self.$q.reject() here, error is already printed by the queryCtrl
          // console.log("target is not yet valid: " + error);
          return self.$q.when([]);
        }
        var metric_name;
        var resource_search;
        var resource_type;
        var resource_id;
        var metric_id;
        var label;

        try {
          metric_name = self.templateSrv.replace(target.metric_name);
          resource_search = self.templateSrv.replace(target.resource_search);
          resource_type = self.templateSrv.replace(target.resource_type);
          resource_id = self.templateSrv.replace(target.resource_id);
          metric_id = self.templateSrv.replace(target.metric_id);
          label = self.templateSrv.replace(target.label);
        } catch (err) {
          return self.$q.reject(err);
        }

        resource_type = resource_type || "generic";

        if (target.queryMode === "resource_search") {
          var resource_search_req = {
            url: 'v1/search/resource/' + resource_type,
            method: 'POST',
            data: resource_search
          };
          return self._gnocchi_request(resource_search_req).then(function(result) {
            return self.$q.all(_.map(result, function(resource) {
              var measures_req = _.merge({}, default_measures_req);
              measures_req.url = ('v1/resource/' + resource_type +
                                  '/' + resource["id"] + '/metric/' + metric_name + '/measures');
              return self._retrieve_measures(resource[label] || label, measures_req);
            }));
          });
        } else if (target.queryMode === "resource_aggregation") {
          default_measures_req.url = ('v1/aggregation/resource/' +
                                      resource_type + '/metric/' + metric_name);
          default_measures_req.method = 'POST';
          default_measures_req.data = target.resource_search;
          return self._retrieve_measures(label || "unlabeled", default_measures_req);

        } else if (target.queryMode === "resource") {
          var resource_req = {
            url: 'v1/resource/' + resource_type+ '/' + resource_id,
            method: 'GET'
          };

          return self._gnocchi_request(resource_req).then(function(resource) {
            label = resource[label] || label;
            if (!label) { label = resource_id ; }
            default_measures_req.url = ('v1/resource/' + resource_type+ '/' +
                                        resource_id + '/metric/' + metric_name+ '/measures');
            return self._retrieve_measures(label, default_measures_req);
          });
        } else if (target.queryMode === "metric") {
          default_measures_req.url = 'v1/metric/' + metric_id + '/measures';
          return self._retrieve_measures(metric_id, default_measures_req);
        }
      });

      return self.$q.all(promises).then(function(results) {
        return { data: _.flatten(results) };
      });
    }

    _retrieve_measures(name, reqs) {
      var self = this;
      return self._gnocchi_request(reqs).then(function(result) {
        var dps = [];
        var fill_with_zero = true;
        var last_granularity;
        var last_timestamp;
        var last_value;
        // NOTE(sileht): sample are ordered by granularity, then timestamp.
        _.each(result, function(metricData) {
          var granularity = metricData[1];
          var timestamp = moment(metricData[0], moment.ISO_8601);
          var value = metricData[2];

          if (!fill_with_zero) {
            dps.push([value, timestamp.valueOf()]);
          } else {
            if (last_timestamp !== undefined){
              // We got a more precise granularity
              if (last_timestamp.valueOf() >= timestamp.valueOf()){
                return;
              }
              var c_timestamp = last_timestamp;
              while (c_timestamp.valueOf() < timestamp.valueOf()) {
                dps.push([last_value, c_timestamp.valueOf()]);
                c_timestamp.add(last_granularity, "seconds");
                last_granularity = granularity;
                last_value = 0;
              }
            }
            last_timestamp = timestamp;
            last_granularity = granularity;
            last_value = value;
          }
        });
        if (fill_with_zero) {
          dps.push([last_value, last_timestamp.valueOf()]);
        }
        return { target: name, datapoints: dps };
      });
    }

    performSuggestQuery(query, type, target) {
      var self = this;
      var options = {url: null};
      var attribute = "id";
      var getter = function(result) {
        return _.map(result, function(item) {
          return item[attribute];
        });
      };

      if (type === 'metrics') {
        options.url = 'v1/metric';

      } else if (type === 'resources') {
        options.url = 'v1/resource/generic';

      } else if (type === 'metric_names') {
        if (target.queryMode === "resource" && target.resource_id !== "") {
          options.url = 'v1/resource/generic/' + target.resource_id;
          getter = function(result) {
            return Object.keys(result["metrics"]);
          };
        } else{
          return self.$q.when([]);
        }
      } else {
        return self.$q.when([]);
      }
      return self._gnocchi_request(options).then(getter);
    }

    metricFindQuery(query) {
      var self = this;
      var req = { method: 'POST', url: null, data: null };
      var resourceQuery = query.match(/^resources\(([^,]*),\s?([^,]*),\s?([^\)]+?)\)/);
      if (resourceQuery) {
        try {
          // Ensure self is json
          req.data = self.templateSrv.replace(angular.toJson(angular.fromJson(resourceQuery[3])));
          req.url = self.templateSrv.replace('v1/search/resource/' + resourceQuery[1]);
        } catch (err) {
          return self.$q.reject(err);
        }
        return self._gnocchi_request(req).then(function(result) {
          return _.map(result, function(resource) {
            return { text: resource[resourceQuery[2]] };
          });
        });
      }

      var metricsQuery = query.match(/^metrics\(([^\)]+?)\)/);
      if (metricsQuery) {
        try {
          req.method = 'GET';
          req.url = 'v1/resource/generic/' + self.templateSrv.replace(metricsQuery[1]);
        } catch (err) {
          return self.$q.reject(err);
        }
        return self._gnocchi_request(req).then(function(resource) {
          return _.map(Object.keys(resource["metrics"]), function(m) {
            return { text: m };
          });
        });
      }

      return self.$q.when([]);
    }

    testDatasource() {
      var self = this;
      return self._gnocchi_request({'url': 'v1/resource'}).then(function () {
        return { status: "success", message: "Data source is working", title: "Success" };
      }, function(reason) {
        if (reason.status === 401) {
          return { status: "error", message: "Data source authentification fail", title: "Authentification error" };
        } else if (reason.message !== undefined && reason.message) {
          return { status: "error", message: reason.message, title: "Error" };
        } else {
          return { status: "error", message: reason || 'Unexpected error (is cors configured correctly ?)', title: "Error" };
        }
      });
    }

    ////////////////
    /// Query
    ////////////////

    validateSearchTarget(target) {
      var self = this;
      var resource_search_req = {
        url: 'v1/search/resource/' + (target.resource_type || 'generic'),
        method: 'POST',
        data: target.resource_search,
      };
      return self._gnocchi_request(resource_search_req);
    }

    //////////////////////
    /// Utils
    //////////////////////

    validateTarget(target, syntax_only) {
      var self = this;
      var mandatory = [];
      switch (target.queryMode) {
        case "metric":
          if (!target.metric_id) {
            mandatory.push("Metric ID");
          }
          break;
        case "resource":
          if (!target.resource_id) {
            mandatory.push("Resource ID");
          }
          if (!target.metric_name) {
            mandatory.push("Metric name");
          }
          break;
        case "resource_aggregation":
        case "resource_search":
          if (!target.resource_search) {
            mandatory.push("Query");
          }
          if (!target.metric_name) {
            mandatory.push("Metric name");
          }
          break;
        default:
          break;
      }
      if (mandatory.length > 0) {
        return "Missing or invalid fields: " + mandatory.join(", ");
      } else if (syntax_only) {
        return;
      }

      switch (target.queryMode) {
        case "resource_aggregation":
        case "resource_search":
          self.validateSearchTarget(target).then(undefined, function(result) {
            if (result){
                return result.message;
            } else {
                return "Unexpected error";
            }
          });
          break;
      }
      return;
    }

    sanitize_url(url) {
      if (url[url.length - 1] !== '/') {
        return url + '/';
      } else {
        return url;
      }
    }

    //////////////////////
    /// KEYSTONE STUFFS
    //////////////////////

    _gnocchi_request(additional_options) {
      var self = this;
      var deferred = self.$q.defer();
      self._gnocchi_auth_request(deferred, function() {
        var options = {
          url: "",
          method: 'GET',
          headers: self.default_headers,
        };
        angular.merge(options, additional_options);
        if (self.url){
          options.url = self.url + options.url;
        }
        return self.backendSrv.datasourceRequest(options).then(function(response) {
          deferred.resolve(response.data);
        });
      }, true);
      return deferred.promise;
    }

    _gnocchi_auth_request(deferred, callback, retry) {
      var self = this;
      if (self.keystone_endpoint !== null && self.url === null){
        self._keystone_auth_request(deferred, callback);
      } else {
        callback().then(undefined, function(reason) {
          if (reason.status === undefined){
            reason.message = "Gnocchi error: No response status code, is CORS correctly configured ?";
            deferred.reject(reason);
          } else if (reason.status === 0){
            reason.message = "Gnocchi error: Connection failed";
            deferred.reject(reason);
          } else if (reason.status === 401) {
            if (self.keystone_endpoint !== null && retry){
              self._keystone_auth_request(deferred, callback);
            } else {
              deferred.reject({'message': "Gnocchi authentication failure"});
            }
          } else if (reason.status === 404 && reason.data !== undefined) {
            reason.message = "Metric not found: " + reason.data.replace(/<[^>]+>/gm, '').replace(/404 Not Found/gm, ""); // Strip html tag
            deferred.reject(reason);
          } else if (reason.status === 400 && reason.data !== undefined) {
            reason.message = "Malformed query: " + reason.data.replace(/<[^>]+>/gm, '').replace(/400 Bad Request/gm, ""); // Strip html tag
            deferred.reject(reason);
          } else if (reason.status >= 300 && reason.data !== undefined) {
            reason.message = 'Gnocchi error: ' + reason.data.replace(/<[^>]+>/gm, '');  // Strip html tag
            deferred.reject(reason);
          } else if (reason.status){
            reason.message = 'Gnocchi error: ' + reason;
            deferred.reject(reason);
          }
        });
      }
    }

    _keystone_auth_request(deferred, callback) {
      var self = this;
      var options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        url: self.keystone_endpoint + 'v3/auth/tokens',
        data: {
          "auth": {
            "identity": {
              "methods": ["password"],
              "password": {
                "user": {
                  "name": self.username,
                  "password": self.password,
                  "domain": { "id": "default"  }
                }
              }
            },
            "scope": {
              "project": {
                "domain": { "id": "default" },
                "name": self.project,
              }
            }
          }
        }
      };

      self.backendSrv.datasourceRequest(options).then(function(result) {
        self.default_headers['X-Auth-Token'] = result.headers('X-Subject-Token');
        _.each(result.data['token']['catalog'], function(service) {
          if (service['type'] === 'metric') {
            _.each(service['endpoints'], function(endpoint) {
              if (endpoint['interface'] === 'public') {
                self.url = self.sanitize_url(endpoint['url']);
              }
            });
          }
        });
        if (self.url) {
          self._gnocchi_auth_request(deferred, callback, false);
        } else {
          deferred.reject({'message': "'metric' endpoint not found in Keystone catalog"});
        }
      }, function(reason) {
        var message;
        if (reason.status === 0){
          message = "Connection failed";
        } else {
          if (reason.status !== undefined) {
              message = '(' + reason.status + ' ' + reason.statusText + ') ';
              if (reason.data && reason.data.error) {
                message += ' ' + reason.data.error.message;
              }
          } else {
              message = 'No response status code, is CORS correctly configured ?';
          }
        }
        deferred.reject({'message': 'Keystone failure: ' + message});
      });
    }
}
