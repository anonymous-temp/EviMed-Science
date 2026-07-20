package com.sentum.pojo;

import lombok.Data;

import java.util.List;

@Data
public class VaeDownJson {

    private String id;

    private String drugNames ;

    //规格
    private String specifications ;

    private String manufacturers  ;

    private String disease  ;



    private String title ;

    private List<VaeContent> contentlist;

    private Double totalScore;



}
