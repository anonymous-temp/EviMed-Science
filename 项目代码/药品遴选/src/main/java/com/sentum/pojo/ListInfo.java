package com.sentum.pojo;

import java.util.List;

public class ListInfo {
    private String drugNames;
    private String manufacturers;

    private String specifications;
    private String title;
    private List<ScoreItem> contentlist;
    private double totalScore;
    private String _class;


    public String getSpecification() {
        return specifications;
    }
    public void setSpecifications(String specifications) {
        this.specifications = specifications;
    }



    public String getDrugNames() { return drugNames; }
    public void setDrugNames(String drugNames) { this.drugNames = drugNames; }
    public String getManufacturers() { return manufacturers; }
    public void setManufacturers(String manufacturers) { this.manufacturers = manufacturers; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public List<ScoreItem> getContentlist() { return contentlist; }
    public void setContentlist(List<ScoreItem> contentlist) { this.contentlist = contentlist; }
    public double getTotalScore() { return totalScore; }
    public void setTotalScore(double totalScore) { this.totalScore = totalScore; }
    public String get_class() { return _class; }
    public void set_class(String _class) { this._class = _class; }
}
