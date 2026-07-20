package com.sentum.pojo;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@AllArgsConstructor
public class ResultJson {

    //上级标题
    private String superiorTitle;
    //标题
    private String title;
    //普通文本
    private String content;
    //分数集：最下层才有
    private List<Double> scoreList;
    //类型： 标题：1   标题+文本：2   标题+json:3
    private String type;
    //分数   所有层级都有
    private Double score = 0.0;
    //最高得分
    private Double maxScore;
    //json格式的文本
    private JSONArray jsonContent;

    //打分标准
    private  String standard;

    //无参构造    都给个默认值   防止为空前端取不到
    public ResultJson(){
        this.scoreList = new ArrayList<>();
        this.type = "2";
        this.jsonContent = new JSONArray();
        this.maxScore = 0.0;
        this.title = "无标题";
        this.content = "";
        this.score = 0.0;
    }





}
