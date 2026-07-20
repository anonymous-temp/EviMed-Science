package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.List;

@Data
@AllArgsConstructor
@Document("evaluation_vae")
public class Vae {

    private String id;


    //量表名称
    private String scaleName;
    //维度
    private List<Dimension> dimensions;

    //添加者
    private String creator;

    //是否限定研究疾病
    private Boolean limitDisease;



    public Vae() {
        this.scaleName = "";
        this.dimensions = new ArrayList<>();
        this.creator = "";
        this.limitDisease = false;
    }



    @Data
    @AllArgsConstructor
    public static class Dimension {
        //维度名称
        private String dimensionName;
        //总分值
        private int dimensionScore;
        //条目
        private List<Item> items;

        public Dimension() {
            this.dimensionName = "";
            this.dimensionScore = 0;
            this.items = new ArrayList<>();
        }





    }



    @Data
    @AllArgsConstructor
    public static class Item {
        //条目名称
        private String itemName;
        //条目分数
        private int itemScore;
        //细则
        private String detailedRules;

        //结果是单选还是多选   0：单选  1：多选
        private String resultType;

        //评价类型   0：主观评价  1：客观评价
        private String evaluationType;

        //需要引入的资料，多选
        private List<String> importData;


        @Override
        public String toString() {
            return "Item{" +
                    "itemName='" + itemName + '\'' +
                    ", itemScore=" + itemScore +
                    ", detailedRules='" + detailedRules + '\'' +
                    ", resultType='" + resultType + '\'' +
                    ", evaluationType='" + evaluationType + '\'' +
                    ", importData=" + importData +
                    '}';
        }

        public Item() {
            this.itemName = "";
            this.itemScore = 0;
            this.detailedRules = "";
            this.resultType = "0";
            this.evaluationType = "0";
            this.importData = new ArrayList<>();
        }

    }
}
