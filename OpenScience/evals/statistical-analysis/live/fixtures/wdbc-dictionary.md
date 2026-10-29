# WDBC source and coding

Frozen UCI Wisconsin Diagnostic Breast Cancer data, mirrored by sklearn.datasets.load_breast_cancer.
Source: https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic
breast_cancer_yn: 0 = malignant; 1 = benign. Malignancy is the event of interest.
Unnamed: 0 is a serialized row index, not a predictor. One record per tumor; this extract has no longitudinal patient identifier.
The features are measurements computed from digitized FNA images; this is exploratory public-data reanalysis, not clinical deployment validation.
