package com.sentum.drugsafe.pojo;

import lombok.Data;
import org.apache.commons.lang3.StringUtils;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

@Data
public class RoleCod {
    @Field(type = FieldType.Keyword)
    private  String drug;
    @Field(type = FieldType.Keyword)
    private String role;
    @Field(type = FieldType.Keyword)
    private String prodAi;
    @Field(type = FieldType.Keyword)
    private String rechal;
    @Field(type = FieldType.Keyword)
    private String dechal;
    @Field(type = FieldType.Keyword)
    private String dur;
    @Field(type = FieldType.Keyword)
    private String dur2;

    @Field(type = FieldType.Keyword)
    private String reactionOfTime;
    @Field(type = FieldType.Keyword)
    private String reactionOfTime2;




    public void setRechal(String rechal){
        if (StringUtils.isEmpty(rechal)){
            this.rechal =  "未知";
        }else
        if (rechal.equals("Y")){
            this.rechal =  "去激发阳性（减轻、消失）";
        }else
        if (rechal.equals("N")){
            this.rechal =  "去激发阴性（未消失或减轻）";
        }else
        if (rechal.equals("D")){
            this.rechal =  "不适用";
        }else{
            this.rechal =  "未知";
        }

    }


    public void setDechal(String dechal){
        if (StringUtils.isEmpty(dechal)){
            this.dechal =  "未知";
        }else
        if (dechal.equals("Y")){
            this.dechal =  "去激发阳性（减轻、消失）";
        }else
        if (dechal.equals("N")){
            this.dechal =  "去激发阴性（未消失或减轻）";
        }else
        if (dechal.equals("D")){
            this.dechal =  "不适用";
        }else {
            this.dechal =  "未知";
        }


    }
}
