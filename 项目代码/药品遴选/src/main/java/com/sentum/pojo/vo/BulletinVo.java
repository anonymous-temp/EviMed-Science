package com.sentum.pojo.vo;

import lombok.Data;

@Data
public class BulletinVo {

    private String score = "0";

    private String content;



    public void setStringScore(String score) {
        this.score = score;
    }

    public void setScore(Double score) {
        if (score != null) {
            if (score ==0){
                this.score = "0";
            }
            this.score = removeTrailingZerosFromDouble(score);
        } else {
            this.score = "0";
        }
    }

    private String removeTrailingZerosFromDouble(Double value) {
        if (value == (long) value.doubleValue()) {
            return Long.toString(value.longValue());
        } else {
            return value.toString();
        }
    }
}
