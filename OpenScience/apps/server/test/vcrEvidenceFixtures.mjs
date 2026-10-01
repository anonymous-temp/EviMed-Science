// The trial-registry fixtures, recorded from the live API on 2026-09-28
// (memory: a golden fixture is recorded from the wire, never written from the
// docs). Not a `*.test.mjs` file on purpose: `pnpm test:server` globs
// `test/*.test.mjs`, so a fixture that lived in one of them would re-run that
// whole suite in every file that imports it.
//
// `FLAURA` is ClinicalTrials.gov's NCT02296125, reduced to the modules
// `REDUCED_MODULES` keeps and with the prose descriptions clipped; every field
// name, every enumeration word and every number in it is exactly what
//
//   curl 'https://clinicaltrials.gov/api/v2/studies/NCT02296125?format=json'
//
// answered. Regenerate with that request and re-clip if the shape changes —
// the point of the fixture is that it is the wire's shape, not ours.

/** NCT02296125 as the live API answered it, reduced. */
export const FLAURA = Object.freeze(
  {
    "protocolSection": {
      "identificationModule": {
        "nctId": "NCT02296125",
        "briefTitle": "AZD9291 Versus Gefitinib or Erlotinib in Patients With Locally Advanced or Metastatic Non-small Cell Lung Cancer",
        "officialTitle": "A Phase III, Double-blind, Randomised Study to Assess the Safety and Efficacy of"
      },
      "statusModule": {
        "overallStatus": "COMPLETED",
        "startDateStruct": {
          "date": "2014-12-03",
          "type": "ACTUAL"
        },
        "primaryCompletionDateStruct": {
          "date": "2017-06-19",
          "type": "ACTUAL"
        },
        "completionDateStruct": {
          "date": "2025-11-20",
          "type": "ACTUAL"
        }
      },
      "sponsorCollaboratorsModule": {
        "leadSponsor": {
          "name": "AstraZeneca",
          "class": "INDUSTRY"
        }
      },
      "conditionsModule": {
        "conditions": [
          "Locally Advanced or Metastatic EGFR Sensitising Mutation Positive Non Small Cell Lung Cancer"
        ],
        "keywords": [
          "Advanced Non-Small Cell Lung Cancer; EGFRm+; AZD9291; TKI; Phase III"
        ]
      },
      "designModule": {
        "studyType": "INTERVENTIONAL",
        "phases": [
          "PHASE3"
        ],
        "designInfo": {
          "allocation": "RANDOMIZED",
          "interventionModel": "PARALLEL",
          "primaryPurpose": "TREATMENT",
          "maskingInfo": {
            "masking": "TRIPLE",
            "whoMasked": [
              "PARTICIPANT",
              "INVESTIGATOR",
              "OUTCOMES_ASSESSOR"
            ]
          }
        },
        "enrollmentInfo": {
          "count": 674,
          "type": "ACTUAL"
        }
      },
      "armsInterventionsModule": {
        "armGroups": [
          {
            "label": "AZD9291+ placebo",
            "type": "EXPERIMENTAL",
            "description": "AZD9291 (80 mg or 40 mg orally, once daily) plus placebo Erlotinib (150mg or 100",
            "interventionNames": [
              "Drug: AZD9291 80 mg/40 mg + placebo",
              "Drug: Placebo Erlotinib 150/100mg",
              "Drug: Placebo Gefitinib 250 mg"
            ]
          },
          {
            "label": "Standard of Care + placebo AZD9291",
            "type": "ACTIVE_COMPARATOR",
            "description": "Erlotinib (150 mg or 100 mg orally, once daily) or placebo Gefitinib (250 mg ora",
            "interventionNames": [
              "Drug: Erlotinib 150/100 mg",
              "Drug: Gefitinib 250 mg",
              "Drug: Placebo AZD9291 80 mg/ 40 mg"
            ]
          }
        ],
        "interventions": [
          {
            "type": "DRUG",
            "name": "AZD9291 80 mg/40 mg + placebo",
            "description": "The initial dose of AZD9291 80 mg once daily can be reduced ",
            "armGroupLabels": [
              "AZD9291+ placebo"
            ]
          },
          {
            "type": "DRUG",
            "name": "Placebo Erlotinib 150/100mg",
            "description": "The initial dose of Placebo Erlotinib 150 mg once daily can ",
            "armGroupLabels": [
              "AZD9291+ placebo"
            ],
            "otherNames": [
              "Placebo Tarceva 150/100 mg"
            ]
          }
        ]
      },
      "outcomesModule": {
        "primaryOutcomes": [
          {
            "measure": "Median Progression Free Survival (PFS) (Months)",
            "timeFrame": "At baseline and every 6 weeks for the first 18 months and then every 12 weeks relative to randomisation until progression"
          }
        ]
      },
      "eligibilityModule": {
        "eligibilityCriteria": "Inclusion Criteria:\n\n1. Male or female, aged at least 18 years.\n2. Pathologically confirmed adenocarcinoma of the lung.\n3. Locally advanced or metastatic NSCLC, not amenable to curative surgery or radiotherapy.\n4. The tumour harbours one of the 2 common EGFR m",
        "sex": "ALL",
        "minimumAge": "18 Years",
        "stdAges": [
          "ADULT",
          "OLDER_ADULT"
        ]
      },
      "contactsLocationsModule": {
        "locations": [
          {
            "facility": "Research Site",
            "city": "Anaheim",
            "country": "United States"
          },
          {
            "facility": "Research Site",
            "city": "Santa Rosa",
            "country": "United States"
          },
          {
            "facility": "Research Site",
            "city": "West Hills",
            "country": "United States"
          },
          {
            "facility": "Research Site",
            "city": "Tampa",
            "country": "United States"
          }
        ]
      }
    },
    "resultsSection": {
      "participantFlowModule": {
        "groups": [
          {
            "id": "FG000",
            "title": "Osimertinib 80 mg (Global Cohort)",
            "description": "Randomized participants received Osimertinib 80 mg orally once daily ("
          },
          {
            "id": "FG001",
            "title": "SoC EGFR-TKI (Global Cohort)",
            "description": "Randomized participant received Standard of care (SoC) Epidermal growt"
          }
        ],
        "periods": [
          {
            "title": "Overall Study",
            "milestones": [
              {
                "type": "STARTED",
                "achievements": [
                  {
                    "groupId": "FG000",
                    "numSubjects": "279"
                  },
                  {
                    "groupId": "FG001",
                    "comment": "183 participant received gefitinib and 93 participants received erlotinib.",
                    "numSubjects": "277"
                  }
                ]
              }
            ],
            "dropWithdraws": [
              {
                "type": "Withdrawal by Subject",
                "reasons": [
                  {
                    "groupId": "FG000",
                    "numSubjects": "18"
                  },
                  {
                    "groupId": "FG001",
                    "numSubjects": "8"
                  }
                ]
              }
            ]
          }
        ]
      },
      "outcomeMeasuresModule": {
        "outcomeMeasures": [
          {
            "type": "PRIMARY",
            "title": "Median Progression Free Survival (PFS) (Months)",
            "paramType": "MEDIAN",
            "dispersionType": "95% Confidence Interval",
            "unitOfMeasure": "Months",
            "timeFrame": "At baseline and every 6 weeks for the first 18 months and then every 12 weeks relative to randomisation until progression",
            "groups": [
              {
                "id": "OG000",
                "title": "Osimertinib 80 mg (Global Cohort)",
                "description": "Randomized participants received Osimertinib 80 mg orally once daily ("
              },
              {
                "id": "OG001",
                "title": "SoC EGFR-TKI (Global Cohort)",
                "description": "Randomized participant received Standard of care (SoC) Epidermal growt"
              }
            ],
            "denoms": [
              {
                "units": "Participants",
                "counts": [
                  {
                    "groupId": "OG000",
                    "value": "279"
                  },
                  {
                    "groupId": "OG001",
                    "value": "277"
                  }
                ]
              }
            ],
            "classes": [
              {
                "categories": [
                  {
                    "measurements": [
                      {
                        "groupId": "OG000",
                        "value": "18.9",
                        "lowerLimit": "15.2",
                        "upperLimit": "21.4"
                      },
                      {
                        "groupId": "OG001",
                        "value": "10.2",
                        "lowerLimit": "9.6",
                        "upperLimit": "11.1"
                      }
                    ]
                  }
                ]
              }
            ],
            "analyses": [
              {
                "groupIds": [
                  "OG000",
                  "OG001"
                ],
                "nonInferiorityType": "SUPERIORITY",
                "pValue": "<0.0001",
                "statisticalMethod": "Log Rank",
                "paramType": "Hazard Ratio (HR)",
                "paramValue": "0.46",
                "ciPctValue": "95",
                "ciNumSides": "TWO_SIDED",
                "ciLowerLimit": "0.37",
                "ciUpperLimit": "0.57"
              },
              {
                "groupIds": [
                  "OG002",
                  "OG003"
                ],
                "nonInferiorityType": "OTHER",
                "nonInferiorityComment": "The china cohort was not powered for superiority",
                "pValue": "0.0065",
                "statisticalMethod": "Log Rank",
                "paramType": "Hazard Ratio (HR)",
                "paramValue": "0.56",
                "ciPctValue": "95",
                "ciNumSides": "TWO_SIDED",
                "ciLowerLimit": "0.37",
                "ciUpperLimit": "0.85"
              }
            ]
          }
        ]
      }
    },
    "hasResults": true
  }
);
