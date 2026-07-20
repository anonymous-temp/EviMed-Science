package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.text.SimpleDateFormat;
import java.time.OffsetDateTime;
import java.util.Date;
import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_patent_1")
public class Patent {


    private String _id;

    private String title;

    private Integer applicationTime;

    private String type;

    private List<String> patentee;

    private Integer publicDate;

    private String patentNumber;

    private String statusInformation;

    private String status;


    public  String getPublicDate() {
        // 将整数转换为字符串
        Integer dateInt = publicDate;

        String dateStr = String.format("%08d", dateInt);

        // 提取年、月、日
        int year = Integer.parseInt(dateStr.substring(0, 4));
        int month = Integer.parseInt(dateStr.substring(4, 6)) - 1; // 月份从0开始
        int day = Integer.parseInt(dateStr.substring(6, 8));

        // 创建Date对象
        Date date = new Date(year - 1900, month, day); // 注意：年份需要减去1900，月份从0开始

        // 使用SimpleDateFormat格式化日期
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd");
        return dateFormat.format(date);
    }



    public  String getApplicationTime() {
        // 将整数转换为字符串
        Integer dateInt = applicationTime;

        String dateStr = String.format("%08d", dateInt);

        // 提取年、月、日
        int year = Integer.parseInt(dateStr.substring(0, 4));
        int month = Integer.parseInt(dateStr.substring(4, 6)) - 1; // 月份从0开始
        int day = Integer.parseInt(dateStr.substring(6, 8));

        // 创建Date对象
        Date date = new Date(year - 1900, month, day); // 注意：年份需要减去1900，月份从0开始

        // 使用SimpleDateFormat格式化日期
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd");
        return dateFormat.format(date);
    }




}
