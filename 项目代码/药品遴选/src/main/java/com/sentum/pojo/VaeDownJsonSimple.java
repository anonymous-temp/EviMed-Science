package com.sentum.pojo;

import lombok.Data;

import java.util.List;

@Data
public class VaeDownJsonSimple {

    private String id;

    private String drugNames ;

    private String manufacturers  ;

    private String specifications  ;

    private String disease  ;

    private String title ;

    private List<VaeContentSimple> contentlist;

    private Double totalScore;
}
