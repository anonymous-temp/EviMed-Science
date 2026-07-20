package com.sentum.pojo;

import java.util.List;

public class ScoreItem {
    private int maxScore;
    private String title;
    private double score;
    private List<ScoreItem> children;

    public ScoreItem() {}
    public int getMaxScore() { return maxScore; }
    public void setMaxScore(int maxScore) { this.maxScore = maxScore; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public double getScore() { return score; }
    public void setScore(double score) { this.score = score; }
    public List<ScoreItem> getChildren() { return children; }
    public void setChildren(List<ScoreItem> children) { this.children = children; }
}
