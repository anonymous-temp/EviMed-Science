package com.sentum.pojo;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;

import java.util.List;

@Data
public class VaeContent {

    private Double maxScore;

    private String title;


    private String type;

    private String content;

    private String superiorTitle;

    private Double score;

    private List<VaeContent> children;

    private JSONArray jsonContent;
}
