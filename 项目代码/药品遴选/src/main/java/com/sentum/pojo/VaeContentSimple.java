package com.sentum.pojo;

import lombok.Data;

import java.util.List;

@Data
public class VaeContentSimple {
    private Double maxScore;

    private String title;

    private Double score;

    private List<VaeContentSimple> children;
}
